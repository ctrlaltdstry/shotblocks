// Shotblocks v2 — C++ plugin hosting the web UI.
//
// Uses Cinema 4D 2026's built-in HtmlViewerCustomGui (CUSTOMGUI_HTMLVIEWER)
// to render the web UI inside a dockable GeDialog. Because the HTML
// viewer is a first-party C4D widget, docking, layout, and lifecycle
// all "just work" — no WebView2 hosting, no HWND walking, no parenting.
//
// JS <-> C++ bridge
// -----------------
// C++ -> JS: htmlView->PostWebMessage(...) reaches
//            window.chrome.webview.addEventListener('message', ...). Fine.
//
// JS  -> C++: BROKEN through the public SDK in C4D 2026. Both
//             SetWebMessageCallback (postMessage from JS) and
//             SetResourceRequestInterceptCallback (fetch() from JS) are
//             dead — they register cleanly but the callback never fires
//             for any URL. Diagnosis logged as the memory
//             c4d-htmlviewer-postmessage-oneway.md.
//
//             Workaround: a Winsock HTTP server on 127.0.0.1:<OS-picked>
//             runs in a worker thread inside this plugin. JS fetches
//             http://127.0.0.1:PORT/cmd. The worker pushes requests onto
//             a queue, posts SpecialEventAdd to wake the main thread,
//             then blocks until the main thread fulfills a promise with
//             the response body. The port is pushed to JS via
//             PostWebMessage on first navigate.

// Winsock must precede Windows.h so the legacy winsock.h shipped with
// <Windows.h> doesn't get pulled in and collide with winsock2.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <Windows.h>

// Windows.h defines macros (DELETE, ERROR, GetMessage, ...) that collide
// with Maxon API names; the SDK ships an undef header for exactly this
// case. It must sit between the Windows and Maxon includes.
#include "maxon/utilities/undef_win_macros.h"

#include "c4d.h"
#include "c4d_gui.h"
#include "c4d_plugin.h"
#include "c4d_resource.h"
#include "c4d_file.h"
#include "c4d_customgui/customgui_htmlviewer.h"

#include <stdio.h>

#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
#include <string>
#include <thread>

#pragma comment(lib, "Ws2_32.lib")

using namespace cinema;

static const Int32 g_shotblocks_v2_cmd_id = 1000007;

// Custom CoreMessage id the HTTP worker uses to wake the main thread.
// We piggyback the plugin id so dialog instances filter their own work.
static const Int32 g_sb_msg_http_request = g_shotblocks_v2_cmd_id;

static const Int32 ID_HOST_GROUP    = 2000;
static const Int32 ID_HOST_HTMLVIEW = 2001;


// -----------------------------------------------------------------------------
// Per-request work item handed from the HTTP worker thread to the main thread.
// -----------------------------------------------------------------------------
struct HttpRequest
{
	std::string body;                    // JSON request body
	std::promise<std::string> response;  // main thread fulfills with JSON body
};


// -----------------------------------------------------------------------------
// Minimal HTTP/1.0 server pinned to 127.0.0.1. One thread, blocking accept,
// one request per connection. Plenty for command-rate RPC.
// -----------------------------------------------------------------------------
class LocalHttpServer
{
public:
	using Handler = std::function<std::string(const std::string& body)>;

	LocalHttpServer() = default;
	~LocalHttpServer() { Stop(); }

	// Bind to 127.0.0.1:0, start the accept thread. Returns the bound
	// port (>0) on success, 0 on failure.
	UInt16 Start(Handler handler)
	{
		_handler = std::move(handler);

		WSADATA wsa{};
		if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
			return 0;

		_listen = socket(AF_INET, SOCK_STREAM, 0);
		if (_listen == INVALID_SOCKET)
		{
			WSACleanup();
			return 0;
		}

		BOOL reuse = TRUE;
		setsockopt(_listen, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

		sockaddr_in addr{};
		addr.sin_family = AF_INET;
		addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // 127.0.0.1 only
		addr.sin_port = 0;                              // OS picks a free port

		if (bind(_listen, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR)
		{
			closesocket(_listen);
			_listen = INVALID_SOCKET;
			WSACleanup();
			return 0;
		}

		sockaddr_in bound{};
		int boundLen = sizeof(bound);
		if (getsockname(_listen, (sockaddr*)&bound, &boundLen) == SOCKET_ERROR)
		{
			closesocket(_listen);
			_listen = INVALID_SOCKET;
			WSACleanup();
			return 0;
		}
		_port = ntohs(bound.sin_port);

		if (listen(_listen, 8) == SOCKET_ERROR)
		{
			closesocket(_listen);
			_listen = INVALID_SOCKET;
			WSACleanup();
			return 0;
		}

		_stop.store(false);
		_thread = std::thread([this] { AcceptLoop(); });
		return _port;
	}

	void Stop()
	{
		if (_stop.exchange(true))
			return;
		if (_listen != INVALID_SOCKET)
		{
			// closesocket on the listen socket interrupts the blocking accept.
			closesocket(_listen);
			_listen = INVALID_SOCKET;
		}
		if (_thread.joinable())
			_thread.join();
		WSACleanup();
		_port = 0;
	}

	UInt16 Port() const { return _port; }

private:
	void AcceptLoop()
	{
		while (!_stop.load())
		{
			sockaddr_in client{};
			int clientLen = sizeof(client);
			SOCKET conn = accept(_listen, (sockaddr*)&client, &clientLen);
			if (conn == INVALID_SOCKET)
			{
				if (_stop.load())
					return;
				continue;
			}
			// One request per connection; handle inline. If volume grows,
			// move this to a thread pool.
			HandleConnection(conn);
			closesocket(conn);
		}
	}

	static std::string Read(SOCKET s, size_t cap = 64 * 1024)
	{
		std::string buf;
		buf.reserve(2048);
		char tmp[2048];
		// Read until we have headers + Content-Length-worth of body.
		size_t headerEnd = std::string::npos;
		long contentLength = 0;
		while (buf.size() < cap)
		{
			int n = recv(s, tmp, (int)sizeof(tmp), 0);
			if (n <= 0)
				break;
			buf.append(tmp, n);
			if (headerEnd == std::string::npos)
			{
				headerEnd = buf.find("\r\n\r\n");
				if (headerEnd != std::string::npos)
				{
					// Pull Content-Length if present (case-insensitive search).
					std::string headers = buf.substr(0, headerEnd);
					for (auto& c : headers)
						c = (char)std::tolower((unsigned char)c);
					auto pos = headers.find("content-length:");
					if (pos != std::string::npos)
					{
						pos += 15;
						while (pos < headers.size() && (headers[pos] == ' ' || headers[pos] == '\t'))
							++pos;
						contentLength = std::strtol(headers.c_str() + pos, nullptr, 10);
					}
				}
			}
			if (headerEnd != std::string::npos &&
				buf.size() >= headerEnd + 4 + (size_t)contentLength)
				break;
		}
		return buf;
	}

	static void Write(SOCKET s, const std::string& data)
	{
		const char* p = data.data();
		size_t left = data.size();
		while (left > 0)
		{
			int n = send(s, p, (int)left, 0);
			if (n <= 0)
				break;
			p += n;
			left -= n;
		}
	}

	void HandleConnection(SOCKET conn)
	{
		const std::string raw = Read(conn);
		if (raw.empty())
			return;

		// Parse method off the request line. We only care about OPTIONS
		// (CORS preflight) vs anything else (treated as the command POST).
		const bool isOptions = raw.compare(0, 7, "OPTIONS") == 0;

		const std::string corsHeaders =
			"Access-Control-Allow-Origin: *\r\n"
			"Access-Control-Allow-Methods: POST, OPTIONS\r\n"
			"Access-Control-Allow-Headers: Content-Type\r\n";

		if (isOptions)
		{
			const std::string resp =
				"HTTP/1.0 204 No Content\r\n" +
				corsHeaders +
				"Content-Length: 0\r\n\r\n";
			Write(conn, resp);
			return;
		}

		// Extract body after the blank line.
		std::string body;
		const auto headerEnd = raw.find("\r\n\r\n");
		if (headerEnd != std::string::npos)
			body = raw.substr(headerEnd + 4);

		std::string replyBody;
		if (_handler)
			replyBody = _handler(body);
		else
			replyBody = "{\"ok\":false,\"error\":\"no handler\"}";

		char head[256];
		_snprintf_s(head, sizeof(head), _TRUNCATE,
			"HTTP/1.0 200 OK\r\n"
			"%s"
			"Content-Type: application/json\r\n"
			"Content-Length: %zu\r\n\r\n",
			corsHeaders.c_str(),
			replyBody.size());
		Write(conn, std::string(head) + replyBody);
	}

	Handler             _handler;
	SOCKET              _listen{INVALID_SOCKET};
	UInt16              _port{0};
	std::thread         _thread;
	std::atomic<bool>   _stop{false};
};


// -----------------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------------
class ShotblocksV2Dialog : public GeDialog
{
public:
	ShotblocksV2Dialog()
		: _htmlView(nullptr)
		, _navigated(false)
		, _serverStarted(false)
		, _jsHandshakeDone(false)
		, _lastTimeChangedTickMs(0)
		, _httpPort(0)
	{}

	~ShotblocksV2Dialog() override
	{
		// Stop the listener before the dialog evaporates. If we don't,
		// the accept thread can hand the main thread a request it can't
		// service.
		_server.Stop();
	}

	Bool CreateLayout() override
	{
		SetTitle("Shotblocks v2"_s);
		GroupBegin(ID_HOST_GROUP, BFH_SCALEFIT | BFV_SCALEFIT, 1, 0, ""_s, 0);
			_htmlView = AddCustomGui<HtmlViewerCustomGui>(
				ID_HOST_HTMLVIEW, ""_s, BFH_SCALEFIT | BFV_SCALEFIT,
				400, 300, BaseContainer());
		GroupEnd();
		// CreateLayout fires on every Open() — including reopens, where
		// the HTML viewer is rebuilt from scratch. Clear cached state so
		// EnsureNavigated() re-resolves and the JS-side port handshake
		// runs again.
		_htmlView = nullptr;
		_navigated = false;
		_jsHandshakeDone = false;
		SetTimer(250);
		return true;
	}

	Bool InitValues() override
	{
		SetTimer(250);
		return true;
	}

	void Timer(const BaseContainer& /*msg*/) override
	{
		EnsureNavigated();
		AnnouncePortIfReady();
		PostTick();
	}

	Bool CoreMessage(Int32 id, const BaseContainer& msg) override
	{
		if (id == EVMSG_TIMECHANGED)
		{
			_lastTimeChangedTickMs = GeGetMilliSeconds();
			PostTick();
		}
		else if (id == g_sb_msg_http_request)
		{
			DrainHttpQueue();
		}
		return GeDialog::CoreMessage(id, msg);
	}

private:
	// ------- Navigation + JS server-port handshake -------

	void EnsureNavigated()
	{
		if (_navigated)
			return;
		if (!_htmlView)
			_htmlView = static_cast<HtmlViewerCustomGui*>(
				FindCustomGui(ID_HOST_HTMLVIEW, CUSTOMGUI_HTMLVIEWER));
		if (!_htmlView)
			return;

		// Bring up the HTTP listener exactly once for the lifetime of
		// this dialog instance. Server is per-dialog, not per-document.
		StartServerIfNeeded();

		// Build a file:// URL pointing at web/timeline.html sitting next
		// to the plugin DLL.
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksV2Dialog::DispatchHttpStatic,
			&hMod);
		wchar_t dll[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, dll, MAX_PATH);
		wchar_t* lastSlash = wcsrchr(dll, L'\\');
		if (lastSlash)
			*(lastSlash + 1) = 0;
		wchar_t urlBuf[MAX_PATH + 64];
		swprintf_s(urlBuf, MAX_PATH + 64, L"file:///%sweb/timeline.html", dll);
		for (wchar_t* p = urlBuf + 8; *p; ++p)
			if (*p == L'\\')
				*p = L'/';
		char utf8[MAX_PATH + 64] = {0};
		WideCharToMultiByte(CP_UTF8, 0, urlBuf, -1, utf8, sizeof(utf8), nullptr, nullptr);
		maxon::String url(utf8);
		_htmlView->SetUrl(url, URL_ENCODING_UTF16);
		_navigated = true;
		GePrint("[Shotblocks/v2] navigated to "_s + url);
	}

	void StartServerIfNeeded()
	{
		if (_serverStarted)
			return;
		_serverStarted = true;
		_httpPort = _server.Start([this](const std::string& body) {
			// Hop onto the main thread. We push a request, wake C4D, and
			// block until the main thread fulfills the promise.
			HttpRequest req;
			req.body = body;
			std::future<std::string> fut = req.response.get_future();
			{
				std::lock_guard<std::mutex> lk(_queueMu);
				_queue.emplace_back(std::move(req));
			}
			SpecialEventAdd(g_sb_msg_http_request, 0, 0);
			// 2s ceiling defends against the dialog being torn down with
			// an in-flight request — the future would otherwise wait
			// forever. JS sees a timeout, which is the correct signal.
			if (fut.wait_for(std::chrono::seconds(2)) == std::future_status::ready)
				return fut.get();
			return std::string("{\"ok\":false,\"error\":\"timeout\"}");
		});
		if (_httpPort != 0)
		{
			char buf[128];
			_snprintf_s(buf, sizeof(buf), _TRUNCATE,
				"[Shotblocks/v2] HTTP listener on 127.0.0.1:%u", (unsigned)_httpPort);
			GePrint(maxon::String(buf));
		}
		else
		{
			GePrint("[Shotblocks/v2] HTTP listener FAILED to start"_s);
		}
	}

	void AnnouncePortIfReady()
	{
		if (_jsHandshakeDone || !_navigated || _httpPort == 0 || !_htmlView)
			return;
		// Repeat the hello on every Timer tick until JS proves it heard
		// it (by making any HTTP call). The page-load and listener-wired
		// moments don't have a clean handshake we can observe from C++,
		// so we just keep talking until the other side answers.
		char buf[128];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"hello\",\"port\":%u}", (unsigned)_httpPort);
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	// ------- Main-thread queue drain -------

	void DrainHttpQueue()
	{
		while (true)
		{
			HttpRequest req;
			{
				std::lock_guard<std::mutex> lk(_queueMu);
				if (_queue.empty())
					return;
				req = std::move(_queue.front());
				_queue.pop_front();
			}
			req.response.set_value(Dispatch(req.body));
		}
	}

	// Single-place command dispatch. Inputs/outputs are JSON strings.
	std::string Dispatch(const std::string& body)
	{
		// Any successful request proves JS heard the hello. Stop spamming.
		_jsHandshakeDone = true;
		// Cheap substring routing for now. Once command count grows we
		// can pull in a real JSON parser; for ping/click/drag-frame the
		// pattern stays trivial.
		if (body.find("\"kind\":\"ping\"") != std::string::npos)
		{
			GePrint("[Shotblocks/v2] ping received, replying with doc-info"_s);
			PostDocInfo();
			PostTick();
			return "{\"ok\":true,\"kind\":\"pong\"}";
		}
		GePrint("[Shotblocks/v2] unhandled cmd: "_s + maxon::String(body.c_str()));
		return "{\"ok\":false,\"error\":\"unknown command\"}";
	}

	// ------- C++ -> JS state push -------

	void PostTick()
	{
		if (!_htmlView || !_navigated)
			return;
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return;
		Int32 fps = doc->GetFps();
		Int32 frame = doc->GetTime().GetFrame(fps);
		Float nowMs = GeGetMilliSeconds();
		bool playing = (nowMs - _lastTimeChangedTickMs) < 200.0;

		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"tick\",\"frame\":%d,\"fps\":%d,\"playing\":%s}",
			(int)frame, (int)fps, playing ? "true" : "false");
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	void PostDocInfo()
	{
		if (!_htmlView)
			return;
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return;
		Int32 fps = doc->GetFps();
		BaseTime minT = doc->GetMinTime();
		BaseTime maxT = doc->GetMaxTime();
		BaseTime inT  = doc->GetLoopMinTime();
		BaseTime outT = doc->GetLoopMaxTime();
		Int32 docFrames = (Int32)(maxT.GetFrame(fps) - minT.GetFrame(fps));
		Int32 inFrame   = (Int32)(inT.GetFrame(fps)  - minT.GetFrame(fps));
		Int32 outFrame  = (Int32)(outT.GetFrame(fps) - minT.GetFrame(fps));
		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"doc-info\",\"fps\":%d,\"docFrames\":%d,\"playRangeIn\":%d,\"playRangeOut\":%d}",
			(int)fps, (int)docFrames, (int)inFrame, (int)outFrame);
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	// Static thunk referenced only so GetModuleHandleExW has a stable
	// address inside the DLL.
	static void DispatchHttpStatic() {}

private:
	HtmlViewerCustomGui* _htmlView;
	bool                 _navigated;
	bool                 _serverStarted;
	bool                 _jsHandshakeDone;
	Float                _lastTimeChangedTickMs;

	LocalHttpServer      _server;
	UInt16               _httpPort;

	std::mutex                   _queueMu;
	std::deque<HttpRequest>      _queue;
};


// ---------------------------------------------------------------------------
// Command + registration
// ---------------------------------------------------------------------------

class OpenShotblocksV2DialogCommand : public CommandData
{
public:
	OpenShotblocksV2DialogCommand() : _dlg(nullptr) {}

	Bool Execute(BaseDocument* /*doc*/, GeDialog* /*parentManager*/) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksV2Dialog);
		if (!_dlg)
			return false;
		return _dlg->Open(DLG_TYPE::ASYNC, g_shotblocks_v2_cmd_id, -1, -1, 700, 400);
	}

	Bool RestoreLayout(void* secret) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksV2Dialog);
		if (!_dlg)
			return false;
		return _dlg->RestoreLayout(g_shotblocks_v2_cmd_id, 0, secret);
	}

private:
	ShotblocksV2Dialog* _dlg;
};


static Bool RegisterShotblocksV2Commands()
{
	return RegisterCommandPlugin(
		g_shotblocks_v2_cmd_id,
		"Open Shotblocks v2"_s,
		0, nullptr,
		"Dockable web-based Shotblocks UI (v2)"_s,
		NewObjClear(OpenShotblocksV2DialogCommand));
}


Bool cinema::PluginStart()
{
	if (!RegisterShotblocksV2Commands())
		return false;
	GePrint("[Shotblocks/v2] PluginStart OK"_s);
	return true;
}

void cinema::PluginEnd()
{
}

Bool cinema::PluginMessage(Int32 id, void* /*data*/)
{
	switch (id)
	{
		case C4DPL_INIT_SYS:
			if (!g_resource.Init())
				return false;
			return true;
	}
	return false;
}
