// Shotblocks — C++ plugin hosting the web UI.
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
#include <set>
#include <string>
#include <thread>
#include <unordered_map>

#include <commctrl.h>  // SetWindowSubclass — for the dialog WM_SETCURSOR hook

#pragma comment(lib, "Ws2_32.lib")
#pragma comment(lib, "Comctl32.lib")

using namespace cinema;

static const Int32 g_shotblocks_cmd_id = 1000007;

// Custom CoreMessage id the HTTP worker uses to wake the main thread.
// We piggyback the plugin id so dialog instances filter their own work.
static const Int32 g_sb_msg_http_request = g_shotblocks_cmd_id;

static const Int32 ID_HOST_GROUP    = 2000;
static const Int32 ID_HOST_HTMLVIEW = 2001;


// -----------------------------------------------------------------------------
// Compute the inclusive [first, last] keyframe range of a BaseObject.
// Walks the flat CTrack list (vector params like position/rotation are
// already split into per-component CTracks in this list, no recursion
// needed for the camera case). Also walks tags so the v1 shotblocks
// rig — which animates via expression tags — surfaces its keys.
//
// Returns true and fills `outFirst` / `outLast` (in frames) if any
// animation was found, false otherwise.
// -----------------------------------------------------------------------------
static Bool GetAnimatedFrameRange(BaseObject* op, Int32 fps,
                                  Int32* outFirst, Int32* outLast)
{
	if (!op)
		return false;
	BaseTime first = BaseTime(1.0e30);
	BaseTime last  = BaseTime(-1.0e30);
	Bool found = false;

	auto visitTracks = [&](CTrack* head) {
		for (CTrack* t = head; t; t = t->GetNext())
		{
			CCurve* c = t->GetCurve(CCURVE::CURVE, false);
			if (!c || c->GetKeyCount() == 0)
				continue;
			BaseTime s = c->GetStartTime();
			BaseTime e = c->GetEndTime();
			if (s < first)
				first = s;
			if (e > last)
				last = e;
			found = true;
		}
	};
	// Animation contributing to a camera can live in three places:
	//   1) The camera itself — object tracks + tag tracks (an Align to
	//      Spline tag drives position via tag tracks, not object tracks).
	//   2) Child objects under the camera — v1 rig has constraint nulls
	//      below the camera whose tracks drive its pose.
	//   3) Parent objects above the camera — a camera parented under
	//      an animated null inherits the null's transform. Walk the
	//      parent chain up to the document root; each parent's own
	//      tracks AND tag tracks count.
	auto visitObject = [&](BaseObject* o) {
		visitTracks(o->GetFirstCTrack());
		for (BaseTag* tag = o->GetFirstTag(); tag; tag = tag->GetNext())
			visitTracks(tag->GetFirstCTrack());
	};
	visitObject(op);
	// Descend into children (recursive — a v1 rig may have nested nulls).
	auto visitTree = [&](BaseObject* o, auto& self) -> void {
		visitObject(o);
		for (BaseObject* ch = o->GetDown(); ch; ch = ch->GetNext())
			self(ch, self);
	};
	for (BaseObject* ch = op->GetDown(); ch; ch = ch->GetNext())
		visitTree(ch, visitTree);
	// Ascend the parent chain.
	for (BaseObject* p = op->GetUp(); p; p = p->GetUp())
		visitObject(p);

	if (!found)
		return false;
	*outFirst = first.GetFrame(fps);
	*outLast  = last.GetFrame(fps);
	return true;
}


// -----------------------------------------------------------------------------
// Persistence — clip data lives in a hidden helper BaseObject inserted at
// the document root, mirroring the Python plugin (sb_persistence.py). The
// helper is marked via a BaseContainer string key so we can find it again
// across save/load cycles. Per-clip camera BaseLinks are stored on the same
// helper, keyed by BASE+objectId — survives object renames in the OM and
// follows the doc through save/load.
// -----------------------------------------------------------------------------
static const Int32 BCKEY_HELPER_MARKER = 1100;   // String: identifies the helper
static const Int32 BCKEY_CLIPS_JSON    = 1101;   // String: JSON tracks + nextClipId
static const Int32 BCKEY_VERSION       = 1102;   // Int32: monotonic save version
static const Int32 BCKEY_CAM_LINK_BASE = 2100;   // BaseLink at BASE + objectId
// Audio bytes per clip — base64-encoded original-format bytes (WAV /
// MP3) keyed by BCKEY_AUDIO_BASE + clipId. Written once on drop
// (audio-add), read on demand from JS (audio-fetch), removed on clip
// delete (audio-remove). Separate from BCKEY_CLIPS_JSON so the
// normal save-state path doesn't re-ship audio on every clip move.
static const Int32 BCKEY_AUDIO_BASE    = 3100;
static const char  HELPER_MARKER_VALUE[]  = "shotblocks_helper";
static const char  HELPER_NULL_NAME[]     = "_shotblocks";

// Find the existing v2 helper in `doc`, or nullptr.
static BaseObject* FindV2Helper(BaseDocument* doc)
{
	if (!doc) return nullptr;
	for (BaseObject* op = doc->GetFirstObject(); op; op = op->GetNext())
	{
		BaseContainer* bc = op->GetDataInstance();
		if (!bc) continue;
		if (bc->GetString(BCKEY_HELPER_MARKER) == maxon::String(HELPER_MARKER_VALUE))
			return op;
	}
	return nullptr;
}

// Find or create the v2 helper. Hidden + display:none so it never appears
// in the Object Manager or viewport.
static BaseObject* GetOrCreateV2Helper(BaseDocument* doc)
{
	if (!doc) return nullptr;
	BaseObject* helper = FindV2Helper(doc);
	if (helper) return helper;
	helper = BaseObject::Alloc(Onull);
	if (!helper) return nullptr;
	helper->SetName(maxon::String(HELPER_NULL_NAME));
	BaseContainer* bc = helper->GetDataInstance();
	if (bc)
		bc->SetString(BCKEY_HELPER_MARKER, maxon::String(HELPER_MARKER_VALUE));
	helper->ChangeNBit(NBIT::OHIDE, NBITCONTROL::SET);
	doc->InsertObject(helper, nullptr, nullptr);
	GePrint("[Shotblocks/v2] created persistence helper"_s);
	return helper;
}


// -----------------------------------------------------------------------------
// Naive JSON field parsers — enough for our flat {"kind":..., "field":...}
// command bodies. Replace with a real JSON parser when message vocabulary
// outgrows it.
// -----------------------------------------------------------------------------

static Int32 ParseIntField(const std::string& body, const char* fieldName)
{
	std::string needle = std::string("\"") + fieldName + "\"";
	auto p = body.find(needle);
	if (p == std::string::npos) return 0;
	p = body.find(':', p);
	if (p == std::string::npos) return 0;
	++p;
	while (p < body.size() && (body[p] == ' ' || body[p] == '\t')) ++p;
	return (Int32)std::strtol(body.c_str() + p, nullptr, 10);
}

// Parse a quoted string value for `fieldName`. Handles standard JSON
// backslash escapes (\\ \" \n \t \r \/).
static std::string ParseStringField(const std::string& body, const char* fieldName)
{
	std::string out;
	std::string needle = std::string("\"") + fieldName + "\"";
	auto p = body.find(needle);
	if (p == std::string::npos) return out;
	p = body.find(':', p);
	if (p == std::string::npos) return out;
	p = body.find('"', p);
	if (p == std::string::npos) return out;
	++p;
	out.reserve(body.size() - p);
	while (p < body.size() && body[p] != '"')
	{
		if (body[p] == '\\' && p + 1 < body.size())
		{
			char c = body[p + 1];
			if      (c == 'n')  out += '\n';
			else if (c == 't')  out += '\t';
			else if (c == 'r')  out += '\r';
			else if (c == '"')  out += '"';
			else if (c == '\\') out += '\\';
			else if (c == '/')  out += '/';
			else                out += c;
			p += 2;
		}
		else
		{
			out += body[p++];
		}
	}
	return out;
}


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

	// 256 MB cap. Audio-add commands ship the full original audio
	// file as base64 (WAV stays WAV — a 5-minute stereo 44.1k WAV is
	// ~50MB raw, ~67MB base64). Save-state JSON without audio bytes
	// is still tiny (~100KB with peaks for a few clips). The cap
	// here is the per-request body limit, not the per-doc audio
	// limit. Audio bytes live in the helper's BaseContainer keyed by
	// BCKEY_AUDIO_BASE + clipId, separate from the clip JSON.
	static std::string Read(SOCKET s, size_t cap = 256 * 1024 * 1024)
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
class ShotblocksDialog : public GeDialog
{
public:
	ShotblocksDialog()
		: _htmlView(nullptr)
		, _navigated(false)
		, _serverStarted(false)
		, _jsHandshakeDone(false)
		, _hoverActive(false)
		, _lastTimeChangedTickMs(0)
		, _httpPort(0)
	{}

	~ShotblocksDialog() override
	{
		// Stop the listener before the dialog evaporates. If we don't,
		// the accept thread can hand the main thread a request it can't
		// service.
		_server.Stop();
	}

	Bool CreateLayout() override
	{
		SetTitle("Shotblocks"_s);
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
		EnsureCursorSubclass();
		// Advance v2-owned playback. Computes the target frame from
		// wall-clock elapsed time since play started, so timer jitter
		// doesn't accumulate (Python's _playback_anchor_t /
		// _playback_anchor_frame pattern, sb_canvas_playback.py:147).
		// While the user scrub-holds the playhead during playback, the
		// advance is frozen — the timeline stays where they hold it.
		if (_v2Playing && !_v2ScrubPaused)
		{
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				Int32 fps = doc->GetFps();
				if (fps <= 0) fps = 30;
				Float nowMs = GeGetMilliSeconds();
				Float elapsedSec = (nowMs - _v2AnchorMs) / 1000.0;
				Int32 targetFrame = _v2AnchorFrame + (Int32)(elapsedSec * fps);
				BaseTime minT = doc->GetMinTime();
				Int32 minFrame = minT.GetFrame(fps);
				Int32 curFrame = doc->GetTime().GetFrame(fps) - minFrame;
				if (targetFrame != curFrame)
				{
					// End of range? Wrap (loop) or stop.
					if (targetFrame >= _v2RangeOut)
					{
						if (_v2LoopEnabled)
						{
							// Re-anchor so the next tick computes from
							// rangeIn at a wall time corresponding to
							// the overflow past rangeOut. Keeps long-
							// playback drift bounded.
							Int32 overflow = targetFrame - _v2RangeOut;
							Float overflowSec = overflow / (Float)fps;
							_v2AnchorMs    = nowMs - overflowSec * 1000.0;
							_v2AnchorFrame = _v2RangeIn;
							targetFrame    = _v2RangeIn;
						}
						else
						{
							// Stop at end-of-range. Drop timer cadence
							// back to idle so we're not waking 30x/sec
							// when nothing's happening.
							targetFrame = _v2RangeOut - 1;
							_v2Playing = false;
							SetTimer(250);
						}
					}
					doc->SetTime(BaseTime(minFrame + targetFrame, fps));
					EventAdd();
				}
			}
		}
		PostTick();
	}

	// Object Manager → timeline drag handler.
	//
	// Lifecycle: BFM_DRAGRECEIVE fires repeatedly during hover, then
	// once more with BFM_DRAG_FINISHED on drop or BFM_DRAG_LOST on
	// cancel/out-of-area.
	//
	// Outbound to JS:
	//   om-hover  — every hover tick while over our area; carries the
	//               cursor's viewport coords + items + each item's
	//               animated frame range (so the JS ghost can match
	//               the true source duration).
	//   om-drop   — on FINISHED; same payload shape as om-hover.
	//   om-cancel — when hover state transitions from "over us" to
	//               "not over us" (drag continues elsewhere), so the
	//               ghost can disappear.
	//
	// Coord conversion (Screen2Local + GetItemDim → viewport pixels)
	// happens once and is reused for hover + drop. See memory
	// webview2-screen-coords for the rationale.
	Int32 Message(const BaseContainer& msg, BaseContainer& result) override
	{
		if (msg.GetId() != BFM_DRAGRECEIVE)
			return GeDialog::Message(msg, result);

		const Bool lost     = msg.GetBool(BFM_DRAG_LOST);
		const Bool finished = msg.GetBool(BFM_DRAG_FINISHED);

		const Bool overUs = !lost && CheckDropArea(ID_HOST_HTMLVIEW, msg, true, true);
		if (!overUs)
		{
			// Drag left our area. If we were showing a ghost, tell JS
			// to clear it. We don't track which kind of drag was in
			// flight, so post both kinds of cancel — JS clears whichever
			// ghost it had.
			if (_hoverActive && _htmlView)
			{
				_htmlView->PostWebMessage("{\"kind\":\"om-cancel\"}"_s);
				_htmlView->PostWebMessage("{\"kind\":\"file-cancel\"}"_s);
			}
			_hoverActive = false;
			return 0;
		}

		Int32 type = 0;
		void* obj  = nullptr;
		GetDragObject(msg, &type, &obj);
		if (!obj)
			return 0;

		// Coord conversion: screen → dialog-local → HtmlViewer-viewport.
		// Same for every drag type; do it once.
		Int32 sx = msg.GetInt32(BFM_DRAG_SCREENX);
		Int32 sy = msg.GetInt32(BFM_DRAG_SCREENY);
		Screen2Local(&sx, &sy);
		Int32 hvX = 0, hvY = 0, hvW = 0, hvH = 0;
		if (GetItemDim(ID_HOST_HTMLVIEW, &hvX, &hvY, &hvW, &hvH))
		{
			sx -= hvX;
			sy -= hvY;
		}

		// File drags (Explorer / C4D content browser) take a separate
		// path — payload is a filename string, not an AtomArray. Audio
		// files (.wav / .mp3) land on audio lanes via HTML5 Audio for
		// duration; everything else is silently rejected.
		if (type == DRAGTYPE_FILES ||
		    type == DRAGTYPE_FILENAME_OTHER ||
		    type == DRAGTYPE_FILENAME_IMAGE ||
		    type == DRAGTYPE_FILENAME_SCENE)
		{
			Filename* fn = static_cast<Filename*>(obj);
			if (!fn) return 0;
			String pathStr = fn->GetString();
			// Lowercase-extension audio filter. C4D's Filename gives us
			// the suffix but we want a case-insensitive compare.
			String suffix = fn->GetSuffix();
			Char* sx_c = suffix.GetCStringCopy();
			std::string ext = sx_c ? sx_c : "";
			if (sx_c) DeleteMem(sx_c);
			for (auto& c : ext) c = (char)std::tolower((unsigned char)c);
			if (ext != "wav" && ext != "mp3")
			{
				// Non-audio file drag — drop it. (Eventually images /
				// scenes will route elsewhere, but for now they're not
				// our business.)
				if (_hoverActive && _htmlView)
					_htmlView->PostWebMessage("{\"kind\":\"file-cancel\"}"_s);
				_hoverActive = false;
				return 0;
			}

			// Convert to UTF-8 + escape for JSON embedding.
			Char* pc = pathStr.GetCStringCopy();
			std::string pathUtf8 = pc ? pc : "";
			if (pc) DeleteMem(pc);
			std::string escPath;
			escPath.reserve(pathUtf8.size() + 8);
			for (char c : pathUtf8)
			{
				if      (c == '\\') escPath += "\\\\";
				else if (c == '"')  escPath += "\\\"";
				else if (c == '\n') escPath += "\\n";
				else if (c == '\r') escPath += "\\r";
				else if (c == '\t') escPath += "\\t";
				else                escPath += c;
			}

			const char* kindStr = finished ? "file-drop" : "file-hover";
			char head[256];
			_snprintf_s(head, sizeof(head), _TRUNCATE,
				"{\"kind\":\"%s\",\"viewportX\":%d,\"viewportY\":%d,\"path\":\"",
				kindStr, (int)sx, (int)sy);
			maxon::String payload = maxon::String(head)
				+ maxon::String(escPath.c_str())
				+ "\"}"_s;
			if (_htmlView)
				_htmlView->PostWebMessage(payload);

			if (finished)
			{
				_hoverActive = false;
				GePrint("[Shotblocks/v2] file-drop posted: "_s + payload);
			}
			else
			{
				_hoverActive = true;
			}
			return SetDragDestination(MOUSE_POINT_HAND);
		}

		if (type != DRAGTYPE_ATOMARRAY)
			return 0;
		AtomArray* arr = static_cast<AtomArray*>(obj);
		if (arr->GetCount() == 0)
			return 0;

		// Build the items array. Per-item: type, name, animated-range,
		// and (on FINISHED only) an objectId that JS keeps around to
		// later request camera switching via set-active-camera. We only
		// allocate the link on FINISHED so hover-only previews don't
		// leak entries into _cameraLinks.
		BaseDocument* doc = GetActiveDocument();
		const Int32 fps = doc ? doc->GetFps() : 30;
		maxon::String items("["_s);
		for (Int32 i = 0; i < arr->GetCount(); ++i)
		{
			C4DAtom* atom = arr->GetIndex(i);
			BaseList2D* b2 = static_cast<BaseList2D*>(atom);
			if (!b2)
				continue;
			if (i > 0)
				items += ","_s;

			Int32 objectId = 0;
			if (finished && b2->IsInstanceOf(Obase) && doc)
			{
				BaseObject* op = static_cast<BaseObject*>(b2);
				objectId = _nextObjectId++;
				AutoAlloc<BaseLink> link;
				if (link)
				{
					link->SetLink(op);
					_cameraLinks.emplace(objectId, std::move(link));
				}
			}

			char hdr[160];
			_snprintf_s(hdr, sizeof(hdr), _TRUNCATE,
				"{\"type\":%d,\"objectId\":%d,\"name\":\"",
				(int)b2->GetType(), (int)objectId);
			items += maxon::String(hdr);
			items += b2->GetName();
			// Animated range if present. Only BaseObjects (3D objects)
			// have keyframes worth walking; other BaseList2Ds skip.
			Int32 firstFrame = 0, lastFrame = 0;
			Bool hasAnim = false;
			if (b2->IsInstanceOf(Obase))
			{
				BaseObject* op = static_cast<BaseObject*>(b2);
				hasAnim = GetAnimatedFrameRange(op, fps, &firstFrame, &lastFrame);
			}
			char tail[128];
			if (hasAnim)
			{
				_snprintf_s(tail, sizeof(tail), _TRUNCATE,
					"\",\"hasAnim\":true,\"inFrame\":%d,\"outFrame\":%d}",
					(int)firstFrame, (int)lastFrame);
			}
			else
			{
				_snprintf_s(tail, sizeof(tail), _TRUNCATE, "\",\"hasAnim\":false}");
			}
			items += maxon::String(tail);
		}
		items += "]"_s;

		const char* kind = finished ? "om-drop" : "om-hover";
		char head[256];
		_snprintf_s(head, sizeof(head), _TRUNCATE,
			"{\"kind\":\"%s\",\"viewportX\":%d,\"viewportY\":%d,\"items\":",
			kind, (int)sx, (int)sy);
		maxon::String payload = maxon::String(head) + items + "}"_s;
		if (_htmlView)
			_htmlView->PostWebMessage(payload);

		if (finished)
		{
			_hoverActive = false;
			GePrint("[Shotblocks/v2] om-drop posted: "_s + payload);
		}
		else
		{
			_hoverActive = true;
		}
		return SetDragDestination(MOUSE_POINT_HAND);
	}

	Bool CoreMessage(Int32 id, const BaseContainer& msg) override
	{
		if (id == EVMSG_TIMECHANGED)
		{
			_lastTimeChangedTickMs = GeGetMilliSeconds();
			PostTick();
		}
		else if (id == EVMSG_CHANGE)
		{
			CheckForExternalStateChange();
			// Also re-publish doc-info so JS picks up any
			// out-of-band edits to the loop range (e.g. user dragged
			// C4D's native in/out markers in the timeline header).
			PostDocInfo();
		}
		else if (id == g_sb_msg_http_request)
		{
			DrainHttpQueue();
		}
		return GeDialog::CoreMessage(id, msg);
	}

	// Compare the helper's version counter against what we last wrote /
	// loaded. A mismatch means C4D's undo system rolled the helper to
	// a different snapshot (Ctrl+Z / Ctrl+Y on a save-state record);
	// JS needs to reload. PostWebMessage is one-way; JS handles the
	// message by re-firing load-state.
	void CheckForExternalStateChange()
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc) return;
		BaseObject* helper = FindV2Helper(doc);
		if (!helper) return;
		BaseContainer* bc = helper->GetDataInstance();
		if (!bc) return;
		const Int32 curVersion = bc->GetInt32(BCKEY_VERSION);
		if (curVersion == _lastSeenVersion) return;
		_lastSeenVersion = curVersion;
		if (_htmlView && _navigated)
			_htmlView->PostWebMessage("{\"kind\":\"state-changed\"}"_s);
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

		// Build a file:// URL pointing at web/index.html sitting next
		// to the plugin DLL.
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksDialog::DispatchHttpStatic,
			&hMod);
		wchar_t dll[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, dll, MAX_PATH);
		wchar_t* lastSlash = wcsrchr(dll, L'\\');
		if (lastSlash)
			*(lastSlash + 1) = 0;
		wchar_t urlBuf[MAX_PATH + 64];
		swprintf_s(urlBuf, MAX_PATH + 64, L"file:///%sweb/index.html", dll);
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
		if (body.find("\"kind\":\"set-cursor-mode\"") != std::string::npos)
		{
			// JS tells us which tool cursor to force. The dialog-window
			// WM_SETCURSOR subclass reads _cursorMode on every move.
			// Body: {"kind":"set-cursor-mode","mode":"slip"|"razor"|...}.
			int m = CURSOR_DEFAULT;
			if (body.find("\"mode\":\"slip\"") != std::string::npos)
				m = CURSOR_SLIP;
			else if (body.find("\"mode\":\"razor\"") != std::string::npos)
				m = CURSOR_RAZOR;
			// No "select" case — the Select tool uses the OS default
			// cursor (removed to kill the playback cursor flicker).
			else if (body.find("\"mode\":\"av-split\"") != std::string::npos)
				m = CURSOR_AV_SPLIT;
			else if (body.find("\"mode\":\"roll\"") != std::string::npos)
				m = CURSOR_ROLL;
			else if (body.find("\"mode\":\"play-range\"") != std::string::npos)
				m = CURSOR_PLAY_RANGE;
			else if (body.find("\"mode\":\"pen\"") != std::string::npos)
				m = CURSOR_PEN;
			_cursorMode.store(m);
			{
				char b[64];
				_snprintf_s(b, sizeof(b), _TRUNCATE,
					"[Shotblocks/v2] set-cursor-mode -> %d", m);
				GePrint(maxon::String(b));
			}
			// Apply immediately (WM_SETCURSOR only fires on movement),
			// and drive a fast Win32 timer that keeps re-asserting the
			// cursor so WebView2's own resets never show. Kill the
			// timer when we return to no-override.
			if (_cursorSubclassed)
			{
				if (m != CURSOR_DEFAULT)
				{
					HCURSOR c = CurrentForcedCursor();
					if (c) SetCursor(c);
					// ::SetTimer — the Win32 one. Unqualified SetTimer
					// resolves to GeDialog::SetTimer (different sig).
					::SetTimer(_cursorSubclassed, kCursorTimerId, 16, nullptr);
				}
				else
				{
					::KillTimer(_cursorSubclassed, kCursorTimerId);
				}
			}
			return "{\"ok\":true,\"kind\":\"set-cursor-mode-ack\"}";
		}
		if (body.find("\"kind\":\"tool\"") != std::string::npos)
		{
			// Tool palette selection. Body: {"kind":"tool","id":"<name>"}.
			// We just record + log for now — no behavior is wired to the
			// active tool yet.
			std::string id;
			auto pos = body.find("\"id\"");
			if (pos != std::string::npos)
			{
				pos = body.find(':', pos);
				if (pos != std::string::npos)
				{
					pos = body.find('"', pos);
					if (pos != std::string::npos)
					{
						auto end = body.find('"', pos + 1);
						if (end != std::string::npos)
							id = body.substr(pos + 1, end - pos - 1);
					}
				}
			}
			_activeTool = id;
			GePrint("[Shotblocks/v2] tool="_s + maxon::String(id.c_str()));
			return "{\"ok\":true,\"kind\":\"tool-ack\"}";
		}
		if (body.find("\"kind\":\"seek\"") != std::string::npos)
		{
			// Scrub from JS. Body shape: {"kind":"seek","frame":<int>}.
			// Pull the integer after `"frame":`. Naive parse is enough for
			// the one numeric field; replace with a real JSON parser when
			// the message vocabulary grows beyond a handful of commands.
			Int32 frame = 0;
			auto pos = body.find("\"frame\"");
			if (pos != std::string::npos)
			{
				pos = body.find(':', pos);
				if (pos != std::string::npos)
				{
					++pos;
					while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t'))
						++pos;
					frame = (Int32)std::strtol(body.c_str() + pos, nullptr, 10);
				}
			}
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				Int32 fps = doc->GetFps();
				BaseTime minT = doc->GetMinTime();
				BaseTime maxT = doc->GetMaxTime();
				Int32 minFrame = minT.GetFrame(fps);
				Int32 maxFrame = maxT.GetFrame(fps);
				if (frame < 0)
					frame = 0;
				Int32 absFrame = minFrame + frame;
				if (absFrame < minFrame)
					absFrame = minFrame;
				if (absFrame > maxFrame)
					absFrame = maxFrame;
				doc->SetTime(BaseTime(absFrame, fps));
				// If a seek lands DURING v2-owned playback, re-anchor the
				// wall-clock playback clock to the seeked frame — else the
				// next Timer() tick recomputes targetFrame from the stale
				// anchor and snaps the playhead back. Playback then
				// continues from where the scrub dropped it. Mirrors
				// Python's _move_playhead re-anchor (sb_canvas_playback.py:640).
				if (_v2Playing)
				{
					_v2AnchorMs    = GeGetMilliSeconds();
					_v2AnchorFrame = absFrame - minFrame;
				}
				// EVMSG_TIMECHANGED triggers the viewport + timeline + our
				// own PostTick via CoreMessage, keeping every UI in sync.
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"seek-ack\"}";
		}
		if (body.find("\"kind\":\"scrub-begin\"") != std::string::npos)
		{
			// User grabbed the v2 playhead. If v2 playback is running,
			// freeze it — the Timer stops advancing and PostTick reports
			// not-playing, so the timeline + audio hold wherever the
			// scrub puts the playhead. No-op if not v2-playing.
			if (_v2Playing)
				_v2ScrubPaused = true;
			return "{\"ok\":true,\"kind\":\"scrub-begin-ack\"}";
		}
		if (body.find("\"kind\":\"scrub-end\"") != std::string::npos)
		{
			// User released the v2 playhead. Re-anchor the playback
			// clock to the current (scrubbed-to) frame and resume.
			if (_v2ScrubPaused)
			{
				_v2ScrubPaused = false;
				BaseDocument* doc = GetActiveDocument();
				if (doc)
				{
					Int32 fps = doc->GetFps();
					if (fps <= 0) fps = 30;
					Int32 minFrame = doc->GetMinTime().GetFrame(fps);
					_v2AnchorMs    = GeGetMilliSeconds();
					_v2AnchorFrame = doc->GetTime().GetFrame(fps) - minFrame;
				}
			}
			return "{\"ok\":true,\"kind\":\"scrub-end-ack\"}";
		}
		if (body.find("\"kind\":\"set-active-camera\"") != std::string::npos)
		{
			// JS routes the playhead-derived active clip's camera here.
			// Body: {"kind":"set-active-camera","objectId":N} where N=0
			// means "release the BaseDraw back to its default" (gap or
			// orphan case, matching Python _route_camera_for_frame).
			Int32 objectId = 0;
			auto pos = body.find("\"objectId\"");
			if (pos != std::string::npos)
			{
				pos = body.find(':', pos);
				if (pos != std::string::npos)
				{
					++pos;
					while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t'))
						++pos;
					objectId = (Int32)std::strtol(body.c_str() + pos, nullptr, 10);
				}
			}

			BaseDocument* doc = GetActiveDocument();
			BaseDraw* bd = PickTargetBaseDraw(doc);
			Bool changed = false;
			BaseObject* cam = nullptr;
			BaseObject* prevCam = nullptr;
			if (bd && doc)
			{
				if (objectId != 0)
				{
					auto it = _cameraLinks.find(objectId);
					if (it != _cameraLinks.end() && it->second)
						cam = static_cast<BaseObject*>(it->second->GetLink(doc));
				}
				prevCam = bd->GetSceneCamera(doc);
				if (prevCam != cam)
				{
					bd->SetSceneCamera(cam);
					// EventAdd alone reliably repaints the viewport when
					// scrubbing forward (time-change + camera-change land
					// together), but does NOT always repaint when the
					// camera change isn't accompanied by a time change in
					// the same direction — backward scrub from the same
					// frame number that previously belonged to a
					// different clip is the case. DrawViews with
					// FORCEFULLREDRAW pushes the new camera state through
					// to the GL drawport immediately.
					DrawViews(DRAWFLAGS::FORCEFULLREDRAW);
					EventAdd();
					changed = true;
				}
			}
			_currentActiveObjectId = objectId;
			return changed
				? "{\"ok\":true,\"kind\":\"set-active-camera-ack\",\"changed\":true}"
				: "{\"ok\":true,\"kind\":\"set-active-camera-ack\",\"changed\":false}";
		}
		if (body.find("\"kind\":\"save-state\"") != std::string::npos)
		{
			// JS sends the full clip-list JSON as a single string. We
			// don't parse it on this side — it's opaque to C++. Stored
			// verbatim on the v2 helper for later retrieval.
			//
			// Body shape:
			//   {"kind":"save-state","json":"<escaped-json-string>","objectIds":[1,2,5]}
			// objectIds is the list of all currently-live objectIds so
			// we can prune stale BaseLinks (cameras that used to be on
			// timeline clips but were deleted from the timeline).
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";

			// Extract the JSON string value. Naive scan: find '"json":'
			// then read the quoted string with backslash-escape handling.
			std::string json;
			{
				auto p = body.find("\"json\"");
				if (p == std::string::npos)
					return "{\"ok\":false,\"error\":\"missing json field\"}";
				p = body.find(':', p);
				if (p == std::string::npos) return "{\"ok\":false,\"error\":\"bad save body\"}";
				p = body.find('"', p);
				if (p == std::string::npos) return "{\"ok\":false,\"error\":\"bad save body\"}";
				++p;
				while (p < body.size() && body[p] != '"')
				{
					if (body[p] == '\\' && p + 1 < body.size())
					{
						char c = body[p + 1];
						if      (c == 'n')  json += '\n';
						else if (c == 't')  json += '\t';
						else if (c == 'r')  json += '\r';
						else if (c == '"')  json += '"';
						else if (c == '\\') json += '\\';
						else if (c == '/')  json += '/';
						else                json += c;
						p += 2;
					}
					else
					{
						json += body[p++];
					}
				}
			}

			BaseObject* helper = GetOrCreateV2Helper(doc);
			if (!helper) return "{\"ok\":false,\"error\":\"helper alloc failed\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc) return "{\"ok\":false,\"error\":\"helper bc missing\"}";

			doc->StartUndo();
			doc->AddUndo(UNDOTYPE::CHANGE_SMALL, helper);
			bc->SetString(BCKEY_CLIPS_JSON, maxon::String(json.c_str()));
			// Bump a monotonic version counter so EVMSG_CHANGE
			// handlers (including ours) can distinguish "the helper
			// changed because of something the user did via Ctrl+Z"
			// from "we just wrote it ourselves".
			const Int32 newVersion = bc->GetInt32(BCKEY_VERSION) + 1;
			bc->SetInt32(BCKEY_VERSION, newVersion);
			_lastSeenVersion = newVersion;

			// Persist BaseLinks for every currently-live objectId.
			// Removed-from-timeline objectIds (in old _cameraLinks but
			// not in this save's objectIds list) get their BaseContainer
			// entries cleared so the helper doesn't accumulate cruft.
			// Parse the objectIds array.
			std::set<Int32> liveIds;
			{
				auto p = body.find("\"objectIds\"");
				if (p != std::string::npos)
				{
					p = body.find('[', p);
					if (p != std::string::npos)
					{
						++p;
						while (p < body.size() && body[p] != ']')
						{
							while (p < body.size() && (body[p] == ' ' || body[p] == ',' || body[p] == '\t')) ++p;
							if (p >= body.size() || body[p] == ']') break;
							char* endp = nullptr;
							long v = std::strtol(body.c_str() + p, &endp, 10);
							if (endp && endp != body.c_str() + p)
							{
								if (v != 0) liveIds.insert((Int32)v);
								p = endp - body.c_str();
							}
							else
							{
								++p;
							}
						}
					}
				}
			}
			// Write/refresh BaseLinks for every live id we have a
			// _cameraLinks entry for. BaseContainer::SetLink stores a
			// persistent link to the BaseList2D that survives doc save
			// + reload, and follows the object through OM renames.
			for (Int32 id : liveIds)
			{
				auto it = _cameraLinks.find(id);
				if (it == _cameraLinks.end() || !it->second) continue;
				BaseObject* op = static_cast<BaseObject*>(it->second->GetLink(doc));
				if (!op) continue;
				bc->SetLink(BCKEY_CAM_LINK_BASE + id, op);
			}
			doc->EndUndo();
			EventAdd();
			return "{\"ok\":true,\"kind\":\"save-state-ack\"}";
		}
		if (body.find("\"kind\":\"load-state\"") != std::string::npos)
		{
			// JS asks for the persisted blob. Returns the JSON string
			// (escaped for re-embedding) and rebuilds the in-memory
			// _cameraLinks map from the helper's stored BaseLinks so
			// camera routing works on the very first frame after
			// reload — no need to re-drop the cameras.
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = FindV2Helper(doc);
			if (!helper) return "{\"ok\":true,\"kind\":\"load-state-ack\",\"json\":\"\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc) return "{\"ok\":true,\"kind\":\"load-state-ack\",\"json\":\"\"}";

			String raw = bc->GetString(BCKEY_CLIPS_JSON);
			std::string rawUtf8;
			{
				// cinema::String adds GetCStringCopy on top of
				// maxon::String. Returns a heap-allocated UTF-8 buffer
				// that we must free via DeleteMem.
				Char* cstr = raw.GetCStringCopy();
				if (cstr)
				{
					rawUtf8 = cstr;
					DeleteMem(cstr);
				}
			}

			// Rebuild _cameraLinks from the helper's stored BaseLinks.
			// BaseContainer doesn't expose an enumeration API for keys,
			// so we scan a known range (objectId is monotonic from 1).
			_cameraLinks.clear();
			Int32 maxObjectIdSeen = 0;
			const Int32 SCAN_MAX = 4096;
			for (Int32 id = 1; id <= SCAN_MAX; ++id)
			{
				BaseList2D* linked = bc->GetLink(BCKEY_CAM_LINK_BASE + id, doc);
				if (!linked) continue;
				if (!linked->IsInstanceOf(Obase)) continue;
				AutoAlloc<BaseLink> newLink;
				if (!newLink) continue;
				newLink->SetLink(linked);
				_cameraLinks.emplace(id, std::move(newLink));
				if (id > maxObjectIdSeen) maxObjectIdSeen = id;
			}
			if (maxObjectIdSeen + 1 > _nextObjectId)
				_nextObjectId = maxObjectIdSeen + 1;
			// Seed _lastSeenVersion to the helper's current version so
			// the immediate post-load EVMSG_CHANGE (if any) doesn't
			// trigger a spurious state-changed notification.
			_lastSeenVersion = bc->GetInt32(BCKEY_VERSION);

			// Escape the JSON string for embedding in our response.
			std::string esc;
			esc.reserve(rawUtf8.size() + 8);
			for (char c : rawUtf8)
			{
				if      (c == '\\') esc += "\\\\";
				else if (c == '"')  esc += "\\\"";
				else if (c == '\n') esc += "\\n";
				else if (c == '\r') esc += "\\r";
				else if (c == '\t') esc += "\\t";
				else                esc += c;
			}
			std::string resp = "{\"ok\":true,\"kind\":\"load-state-ack\",\"json\":\"";
			resp += esc;
			resp += "\"}";
			return resp;
		}
		if (body.find("\"kind\":\"toggle-play\"") != std::string::npos)
		{
			// Spacebar toggles v2-owned playback. We do NOT call
			// CallCommand(12412) because C4D's native play forward
			// respects C4D's native cycle button, which can't be
			// controlled from the SDK. Instead we run our own timer
			// (see Timer()) that advances doc->SetTime per frame and
			// honors _v2LoopEnabled + the play range.
			//
			// C4D's native play button still works independently —
			// pressing it puts C4D in its own playback mode; we just
			// receive EVMSG_TIMECHANGED and broadcast tick. v2's loop
			// toggle has no effect on C4D-initiated playback.
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			if (_v2Playing)
			{
				_v2Playing = false;
				// Drop the timer back to idle cadence.
				SetTimer(250);
			}
			else
			{
				_v2Playing = true;
				Int32 fps = doc->GetFps();
				if (fps <= 0) fps = 30;
				BaseTime minT = doc->GetMinTime();
				Int32 minFrame = minT.GetFrame(fps);
				Int32 curFrame = doc->GetTime().GetFrame(fps) - minFrame;
				// If the playhead is outside the play range, snap to
				// rangeIn before starting (Python behavior at
				// sb_canvas_playback.py:137).
				if (curFrame < _v2RangeIn || curFrame >= _v2RangeOut)
				{
					curFrame = _v2RangeIn;
					doc->SetTime(BaseTime(minFrame + curFrame, fps));
					EventAdd();
				}
				_v2AnchorMs    = GeGetMilliSeconds();
				_v2AnchorFrame = curFrame;
				// Bump timer to ~fps cadence so playback advances
				// smoothly; idle cadence is 250ms.
				Int32 period = 1000 / fps;
				if (period < 1) period = 1;
				SetTimer(period);
			}
			PostTick();
			return "{\"ok\":true,\"kind\":\"toggle-play-ack\"}";
		}
		if (body.find("\"kind\":\"set-play-range\"") != std::string::npos)
		{
			// Cache the v2 play range in C++ memory. NOT synced to
			// C4D's LoopMin/MaxTime — that would make C4D's own
			// player wrap on the range, overruling v2's loop toggle.
			// v2's playback timer reads this cache to enforce loop
			// behavior; C4D's native play button ignores it.
			Int32 inFrame  = ParseIntField(body, "inFrame");
			Int32 outFrame = ParseIntField(body, "outFrame");
			if (inFrame  < 0) inFrame  = 0;
			if (outFrame <= inFrame) outFrame = inFrame + 1;
			_v2RangeIn  = inFrame;
			_v2RangeOut = outFrame;
			return "{\"ok\":true,\"kind\":\"set-play-range-ack\"}";
		}
		if (body.find("\"kind\":\"set-loop\"") != std::string::npos)
		{
			// Cache v2's loop flag. Read by the playback timer at the
			// end-of-range boundary to decide between wrap and stop.
			_v2LoopEnabled = body.find("\"enabled\":true") != std::string::npos;
			return "{\"ok\":true,\"kind\":\"set-loop-ack\"}";
		}
		if (body.find("\"kind\":\"audio-add\"") != std::string::npos)
		{
			// JS pushes the original audio bytes (base64) once at drop
			// time. Stored in the helper's BaseContainer keyed by
			// BCKEY_AUDIO_BASE + clipId. The clip-list JSON references
			// audio by clipId — bytes never re-ship on subsequent clip
			// moves / trims / saves.
			Int32 clipId = ParseIntField(body, "clipId");
			if (clipId <= 0)
				return "{\"ok\":false,\"error\":\"bad clipId\"}";
			std::string bytes = ParseStringField(body, "bytes");
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = GetOrCreateV2Helper(doc);
			if (!helper) return "{\"ok\":false,\"error\":\"helper alloc failed\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc) return "{\"ok\":false,\"error\":\"helper bc missing\"}";

			doc->StartUndo();
			doc->AddUndo(UNDOTYPE::CHANGE_SMALL, helper);
			bc->SetString(BCKEY_AUDIO_BASE + clipId, maxon::String(bytes.c_str()));
			// Bump version so EVMSG_CHANGE handlers (Ctrl+Z / Ctrl+Y
			// detection) stay in sync.
			const Int32 newVersion = bc->GetInt32(BCKEY_VERSION) + 1;
			bc->SetInt32(BCKEY_VERSION, newVersion);
			_lastSeenVersion = newVersion;
			doc->EndUndo();
			EventAdd();
			return "{\"ok\":true,\"kind\":\"audio-add-ack\"}";
		}
		if (body.find("\"kind\":\"audio-fetch\"") != std::string::npos)
		{
			// JS asks for the persisted audio bytes for one clipId.
			// Called on doc load for each audio clip we don't already
			// have in JS memory. Returns base64 string (possibly empty
			// if the clip predates audio import or has no bytes stored).
			Int32 clipId = ParseIntField(body, "clipId");
			if (clipId <= 0)
				return "{\"ok\":false,\"error\":\"bad clipId\"}";
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = FindV2Helper(doc);
			if (!helper)
				return "{\"ok\":true,\"kind\":\"audio-fetch-ack\",\"bytes\":\"\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc)
				return "{\"ok\":true,\"kind\":\"audio-fetch-ack\",\"bytes\":\"\"}";

			String raw = bc->GetString(BCKEY_AUDIO_BASE + clipId);
			std::string rawUtf8;
			Char* cstr = raw.GetCStringCopy();
			if (cstr)
			{
				rawUtf8 = cstr;
				DeleteMem(cstr);
			}
			// The stored value is itself a base64 string (no JSON-
			// special characters), so we can embed it verbatim. The
			// only escape needed is the JSON-string termination.
			std::string resp = "{\"ok\":true,\"kind\":\"audio-fetch-ack\",\"bytes\":\"";
			resp += rawUtf8;
			resp += "\"}";
			return resp;
		}
		if (body.find("\"kind\":\"audio-remove\"") != std::string::npos)
		{
			// JS notifies that a clip with audio was deleted. Free the
			// helper's storage so deleted audio doesn't ride along in
			// the doc.
			Int32 clipId = ParseIntField(body, "clipId");
			if (clipId <= 0)
				return "{\"ok\":false,\"error\":\"bad clipId\"}";
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = FindV2Helper(doc);
			if (!helper)
				return "{\"ok\":true,\"kind\":\"audio-remove-ack\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc)
				return "{\"ok\":true,\"kind\":\"audio-remove-ack\"}";

			doc->StartUndo();
			doc->AddUndo(UNDOTYPE::CHANGE_SMALL, helper);
			bc->RemoveData(BCKEY_AUDIO_BASE + clipId);
			const Int32 newVersion = bc->GetInt32(BCKEY_VERSION) + 1;
			bc->SetInt32(BCKEY_VERSION, newVersion);
			_lastSeenVersion = newVersion;
			doc->EndUndo();
			EventAdd();
			return "{\"ok\":true,\"kind\":\"audio-remove-ack\"}";
		}
		if (body.find("\"kind\":\"undo\"") != std::string::npos)
		{
			// WebView2 swallows Ctrl+Z before C4D's menu sees it, so JS
			// forwards the keystroke here. We invoke C4D's native undo
			// (DoUndo). The undo will roll back the helper's
			// BaseContainer, EVMSG_CHANGE will fire, our handler will
			// detect the version mismatch and tell JS to reload.
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				doc->DoUndo();
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"undo-ack\"}";
		}
		if (body.find("\"kind\":\"redo\"") != std::string::npos)
		{
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				doc->DoRedo();
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"redo-ack\"}";
		}
		GePrint("[Shotblocks/v2] unhandled cmd: "_s + maxon::String(body.c_str()));
		return "{\"ok\":false,\"error\":\"unknown command\"}";
	}

	// Pick the BaseDraw the camera router writes to. First call pins
	// the choice — preferring a perspective view — so 4-up layouts'
	// Top / Front / Side viewports don't get hijacked when the user
	// focuses one. Subsequent calls reuse the pin unless the pinned
	// BaseDraw was destroyed. Matches Python _pick_target_basedraw
	// (sb_canvas_playback.py:192).
	BaseDraw* PickTargetBaseDraw(BaseDocument* doc)
	{
		if (!doc) return nullptr;
		// Verify the pin is still alive in this document by walking
		// the BaseDraw list.
		if (_pinnedBaseDraw)
		{
			for (Int32 i = 0; ; ++i)
			{
				BaseDraw* bd = doc->GetBaseDraw(i);
				if (!bd) break;
				if (bd == _pinnedBaseDraw)
					return _pinnedBaseDraw;
			}
			_pinnedBaseDraw = nullptr;  // stale
		}
		// First call (or stale pin): prefer the first perspective BD.
		for (Int32 i = 0; ; ++i)
		{
			BaseDraw* bd = doc->GetBaseDraw(i);
			if (!bd) break;
			GeData proj;
			bd->GetParameter(ConstDescID(DescLevel(BASEDRAW_DATA_PROJECTION)), proj, DESCFLAGS_GET::NONE);
			if (proj.GetInt32() == BASEDRAW_PROJECTION_PERSPECTIVE)
			{
				_pinnedBaseDraw = bd;
				return bd;
			}
		}
		// No perspective view — fall back to active BD.
		_pinnedBaseDraw = doc->GetActiveBaseDraw();
		return _pinnedBaseDraw;
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
		// `playing` reflects EITHER v2-owned playback (spacebar) OR any
		// C4D-native timeline activity (play button OR scrubbing — both
		// fire EVMSG_TIMECHANGED, indistinguishable from here). The
		// visual playhead syncs to `playing` either way.
		// `pluginPlaying` is the NARROW signal: true only for v2-owned
		// playback. The audio layer uses it to honor the "audio follows
		// C4D timeline" setting — when that's off, audio responds to
		// pluginPlaying only, so C4D-native scrub/play makes no sound.
		bool externalPlaying = (nowMs - _lastTimeChangedTickMs) < 200.0;
		bool playing = _v2Playing || externalPlaying;
		bool pluginPlaying = _v2Playing;
		// A scrub-hold during playback freezes transport — report
		// not-playing so the timeline + audio stop at the held frame.
		// (externalPlaying would otherwise stay true: each scrub seek
		// fires EVMSG_TIMECHANGED.)
		if (_v2ScrubPaused)
		{
			playing = false;
			pluginPlaying = false;
		}

		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"tick\",\"frame\":%d,\"fps\":%d,\"playing\":%s,\"pluginPlaying\":%s}",
			(int)frame, (int)fps, playing ? "true" : "false",
			pluginPlaying ? "true" : "false");
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
		Int32 docFrames = (Int32)(maxT.GetFrame(fps) - minT.GetFrame(fps));
		// playRange fields broadcast the v2-owned cache, not C4D's
		// native loop bounds (which v2 deliberately doesn't touch so
		// C4D's own play button stays independent). On first
		// connection, default to [0, docFrames] so JS sees the full
		// doc as "no play range defined."
		if (_v2RangeOut > docFrames || _v2RangeOut == (1 << 30))
			_v2RangeOut = docFrames;
		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"doc-info\",\"fps\":%d,\"docFrames\":%d,\"playRangeIn\":%d,\"playRangeOut\":%d}",
			(int)fps, (int)docFrames, (int)_v2RangeIn, (int)_v2RangeOut);
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	// Static thunk referenced only so GetModuleHandleExW has a stable
	// address inside the DLL.
	static void DispatchHttpStatic() {}

	// --- Cursor ownership -------------------------------------------
	// The slip cursor wouldn't persist after a drag. WebView2's render
	// window is cross-process (can't subclass), and DOM/JS cursor
	// pokes don't drive the native cursor. The remaining suspect:
	// C4D's own dialog window handles WM_SETCURSOR for its region (the
	// HtmlViewerCustomGui is a child inside the C4D dialog) and resets
	// the cursor on every move. C4D's dialog HWND IS in our process,
	// so we CAN subclass it. When the slip cursor mode is on, our
	// WM_SETCURSOR handler sets the slip cursor and returns TRUE,
	// winning over both C4D and WebView2.
	//
	// `_cursorMode` is set by JS (`set-cursor-mode`): a tool-cursor id
	// to force, or 0 = let C4D/WebView2 decide. Atomic — HTTP worker
	// thread writes, UI thread's subclass proc reads. Mode ids match
	// CursorMode below.
	enum CursorMode {
		CURSOR_DEFAULT    = 0,
		CURSOR_SLIP       = 1,
		CURSOR_RAZOR      = 2,
		CURSOR_SELECT     = 3,
		CURSOR_AV_SPLIT   = 4,
		CURSOR_ROLL       = 5,
		CURSOR_PLAY_RANGE = 6,
		CURSOR_PEN        = 7,
	};

	// Load one multi-resolution .cur from <plugin>/web/cursors/.
	// LoadCursorFromFileW picks the DPI-appropriate image out of the
	// 32/48/64 set; LoadImage+LR_DEFAULTSIZE would force 32px.
	HCURSOR LoadCursorFile(const wchar_t* pluginDir, const wchar_t* file)
	{
		wchar_t curPath[MAX_PATH + 64];
		swprintf_s(curPath, MAX_PATH + 64, L"%sweb\\cursors\\%s", pluginDir, file);
		HCURSOR c = LoadCursorFromFileW(curPath);
		if (!c)
		{
			char u8[MAX_PATH + 64] = {0};
			WideCharToMultiByte(CP_UTF8, 0, curPath, -1, u8, sizeof(u8), nullptr, nullptr);
			GePrint(maxon::String("[Shotblocks/v2] cursor failed to load: ") + maxon::String(u8));
		}
		return c;
	}

	void LoadCursors()
	{
		if (_cursorsLoaded)
			return;
		_cursorsLoaded = true;
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksDialog::DispatchHttpStatic, &hMod);
		wchar_t path[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, path, MAX_PATH);
		wchar_t* lastSlash = wcsrchr(path, L'\\');
		if (lastSlash)
			*(lastSlash + 1) = 0;
		// No select.cur — the Select tool uses the OS default cursor.
		_slipCursor    = LoadCursorFile(path, L"slip.cur");
		_razorCursor   = LoadCursorFile(path, L"razor.cur");
		_avSplitCursor   = LoadCursorFile(path, L"av-split.cur");
		_rollCursor      = LoadCursorFile(path, L"roll.cur");
		_playRangeCursor = LoadCursorFile(path, L"play-range.cur");
		_penCursor       = LoadCursorFile(path, L"pen.cur");
		char b[224];
		_snprintf_s(b, sizeof(b), _TRUNCATE,
			"[Shotblocks/v2] cursors loaded: slip=%d razor=%d avsplit=%d roll=%d playrange=%d pen=%d",
			_slipCursor ? 1 : 0, _razorCursor ? 1 : 0,
			_avSplitCursor ? 1 : 0, _rollCursor ? 1 : 0, _playRangeCursor ? 1 : 0,
			_penCursor ? 1 : 0);
		GePrint(maxon::String(b));
	}

	// The cursor currently forced by JS, or null for "no override".
	HCURSOR CurrentForcedCursor()
	{
		switch (_cursorMode.load())
		{
			case CURSOR_SLIP:     return _slipCursor;
			case CURSOR_RAZOR:    return _razorCursor;
			// CURSOR_SELECT removed — Select tool uses the OS default.
			case CURSOR_AV_SPLIT:   return _avSplitCursor;
			case CURSOR_ROLL:       return _rollCursor;
			case CURSOR_PLAY_RANGE: return _playRangeCursor;
			case CURSOR_PEN:        return _penCursor;
			default:                return nullptr;
		}
	}

	// Win32 timer id used (on the C4D dialog window) to re-assert the
	// slip cursor fast enough that WebView2's own cursor resets don't
	// produce a visible flicker.
	static const UINT_PTR kCursorTimerId = 0x5B1C;

	static LRESULT CALLBACK CursorSubclassProc(
		HWND hwnd, UINT msg, WPARAM wp, LPARAM lp,
		UINT_PTR /*id*/, DWORD_PTR refData)
	{
		auto* self = reinterpret_cast<ShotblocksDialog*>(refData);
		if (self)
		{
			HCURSOR forced = self->CurrentForcedCursor();
			if (forced)
			{
				// While a tool-cursor mode is on, re-assert it on
				// WM_SETCURSOR (mouse moved) AND on our fast WM_TIMER
				// (pointer still — WebView2 resets the cursor on its
				// own events; the timer overwrites it back before the
				// reset is visible).
				// Only force the cursor over the window's CLIENT area.
				// At the window borders / corner the hit-test code is
				// HTLEFT / HTBOTTOMRIGHT / etc. — leave those alone so
				// the OS resize cursor still shows. lp's low word is
				// the hit-test code on WM_SETCURSOR.
				if (msg == WM_SETCURSOR && LOWORD(lp) == HTCLIENT)
				{
					SetCursor(forced);
					return TRUE; // consumed — beats C4D + WebView2
				}
				if (msg == WM_TIMER && wp == kCursorTimerId)
				{
					// The fast timer re-asserts the cursor only when
					// the pointer is genuinely over the client area —
					// not parked on a resize border.
					POINT pt;
					if (GetCursorPos(&pt))
					{
						LRESULT ht = SendMessageW(hwnd, WM_NCHITTEST, 0,
							MAKELPARAM(pt.x, pt.y));
						if (ht == HTCLIENT)
							SetCursor(forced);
					}
				}
			}
		}
		if (msg == WM_NCDESTROY)
		{
			RemoveWindowSubclass(hwnd, &CursorSubclassProc, 1);
			if (self && self->_cursorSubclassed == hwnd)
				self->_cursorSubclassed = nullptr;
		}
		return DefSubclassProc(hwnd, msg, wp, lp);
	}

	// Subclass the C4D dialog window for WM_SETCURSOR. Called from
	// Timer() — cheap no-op once installed.
	void EnsureCursorSubclass()
	{
		if (_cursorSubclassed)
			return;
		HWND dlg = static_cast<HWND>(GetWindowHandle());
		if (!dlg)
			return;
		LoadCursors();
		if (SetWindowSubclass(dlg, &CursorSubclassProc, 1,
			reinterpret_cast<DWORD_PTR>(this)))
		{
			_cursorSubclassed = dlg;
			GePrint("[Shotblocks/v2] cursor subclass installed on C4D dialog"_s);
		}
	}

private:
	HtmlViewerCustomGui* _htmlView;
	bool                 _navigated;
	bool                 _serverStarted;
	bool                 _jsHandshakeDone;
	bool                 _hoverActive;
	Float                _lastTimeChangedTickMs;

	LocalHttpServer      _server;
	UInt16               _httpPort;

	std::mutex                   _queueMu;
	std::deque<HttpRequest>      _queue;

	std::string          _activeTool{"select"};

	// Cursor ownership — see the cursor block above.
	bool                 _cursorsLoaded{false};
	HCURSOR              _slipCursor{nullptr};
	HCURSOR              _razorCursor{nullptr};
	HCURSOR              _avSplitCursor{nullptr};
	HCURSOR              _rollCursor{nullptr};
	HCURSOR              _playRangeCursor{nullptr};
	HCURSOR              _penCursor{nullptr};
	std::atomic<int>     _cursorMode{0};   // CursorMode id; 0 = no override
	HWND                 _cursorSubclassed{nullptr};

	// OM-drop camera registry. Each dragged BaseObject is assigned a
	// session-unique objectId; that id is sent to JS in the om-drop
	// payload and stored on the JS Clip. JS later sends
	// {kind:"set-active-camera", objectId:N} when the playhead enters
	// the clip's range; C++ resolves N via _cameraLinks and writes the
	// BaseObject to the pinned BaseDraw.
	//
	// BaseLink survives object deletion (resolves to null) — matches
	// Python's shot-orphan semantics where the timeline keeps the clip
	// but the camera link goes dead.
	std::unordered_map<Int32, AutoAlloc<BaseLink>> _cameraLinks;
	Int32                _nextObjectId{1};
	// Pinned BaseDraw target — selected on first camera-set call so
	// subsequent calls don't hijack other viewports (per Python
	// _pick_target_basedraw / sb_canvas_playback.py:192).
	BaseDraw*            _pinnedBaseDraw{nullptr};
	Int32                _currentActiveObjectId{0};
	// Helper-version bookkeeping. Bumped on every save-state write;
	// EVMSG_CHANGE compares the current helper version against this
	// cached value to detect when Ctrl+Z / Ctrl+Y rolled the helper
	// back/forward to a different version, in which case we tell JS
	// to reload (push notification → state-changed message).
	Int32                _lastSeenVersion{0};
	// v2-owned playback. Spacebar starts/stops this. While
	// _v2Playing is true, the dialog Timer ticks at fps cadence and
	// advances doc->SetTime(frame+1, fps), honoring _v2LoopEnabled
	// and the [_v2RangeIn, _v2RangeOut) play range. Mirrors Python's
	// _toggle_playback / _playback_tick (sb_canvas_playback.py).
	// C4D's native play button still works independently — that
	// path doesn't set _v2Playing, so the loop logic doesn't apply.
	Bool                 _v2Playing{false};
	// True while the user is scrub-holding the v2 playhead DURING v2
	// playback. The Timer freezes its advance and PostTick reports
	// not-playing, so the timeline + audio hold at the scrubbed frame.
	// scrub-end re-anchors and clears this so playback resumes from
	// the drop point.
	Bool                 _v2ScrubPaused{false};
	Float                _v2AnchorMs{0.0};   // wall-clock anchor at play start
	Int32                _v2AnchorFrame{0};  // doc frame at play start
	Int32                _v2RangeIn{0};
	Int32                _v2RangeOut{1 << 30};
	Bool                 _v2LoopEnabled{false};
};


// ---------------------------------------------------------------------------
// Command + registration
// ---------------------------------------------------------------------------

class OpenShotblocksDialogCommand : public CommandData
{
public:
	OpenShotblocksDialogCommand() : _dlg(nullptr) {}

	Bool Execute(BaseDocument* /*doc*/, GeDialog* /*parentManager*/) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksDialog);
		if (!_dlg)
			return false;
		return _dlg->Open(DLG_TYPE::ASYNC, g_shotblocks_cmd_id, -1, -1, 700, 400);
	}

	Bool RestoreLayout(void* secret) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksDialog);
		if (!_dlg)
			return false;
		return _dlg->RestoreLayout(g_shotblocks_cmd_id, 0, secret);
	}

private:
	ShotblocksDialog* _dlg;
};


static Bool RegisterShotblocksCommands()
{
	return RegisterCommandPlugin(
		g_shotblocks_cmd_id,
		"Shotblocks"_s,
		0, nullptr,
		"Dockable web-based Shotblocks UI"_s,
		NewObjClear(OpenShotblocksDialogCommand));
}


Bool cinema::PluginStart()
{
	if (!RegisterShotblocksCommands())
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
