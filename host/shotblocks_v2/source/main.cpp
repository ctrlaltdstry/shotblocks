// Shotblocks v2 — C++ plugin hosting the web UI.
//
// Uses Cinema 4D 2026's built-in HtmlViewerCustomGui (CUSTOMGUI_HTMLVIEWER)
// to render the web UI inside a dockable GeDialog. Because the HTML
// viewer is a first-party C4D widget, docking, layout, and lifecycle
// all "just work" — no WebView2 hosting, no HWND walking, no parenting.
//
// Demo: a one-page HTML UI under web/demo.html. The page receives
// per-frame ticks (frame/fps/playing) via PostWebMessage, and can
// round-trip via a "Ping C4D" button that sends a JSON message to
// SetWebMessageCallback. We reply with the current frame.

#include "c4d.h"
#include "c4d_gui.h"
#include "c4d_plugin.h"
#include "c4d_resource.h"
#include "c4d_file.h"
#include "c4d_customgui/customgui_htmlviewer.h"

#include <Windows.h>
#include <stdio.h>

using namespace cinema;

static const Int32 g_shotblocks_v2_cmd_id = 1000007;

static const Int32 ID_HOST_GROUP    = 2000;
static const Int32 ID_HOST_HTMLVIEW = 2001;


class ShotblocksV2Dialog : public GeDialog
{
public:
	ShotblocksV2Dialog()
		: _htmlView(nullptr)
		, _navigated(false)
		, _msgCallbackRegistered(false)
		, _lastTimeChangedTickMs(0)
	{}

	Bool CreateLayout() override
	{
		SetTitle("Shotblocks v2"_s);
		GroupBegin(ID_HOST_GROUP, BFH_SCALEFIT | BFV_SCALEFIT, 1, 0, ""_s, 0);
			_htmlView = AddCustomGui<HtmlViewerCustomGui>(
				ID_HOST_HTMLVIEW, ""_s, BFH_SCALEFIT | BFV_SCALEFIT,
				400, 300, BaseContainer());
		GroupEnd();
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
		// Push tick periodically so the page reflects current state
		// even when nothing is changing (e.g. user just sitting at a
		// frame). The fast path is EVMSG_TIMECHANGED, below.
		PostTick();
	}

	Int32 Message(const BaseContainer& msg, BaseContainer& result) override
	{
		// EVMSG_TIMECHANGED arrives via CoreMessage on dialogs, but
		// GeDialog actually routes core messages through CoreMessage().
		// We override that instead.
		return GeDialog::Message(msg, result);
	}

	Bool CoreMessage(Int32 id, const BaseContainer& msg) override
	{
		if (id == EVMSG_TIMECHANGED)
		{
			_lastTimeChangedTickMs = GeGetMilliSeconds();
			PostTick();
		}
		return GeDialog::CoreMessage(id, msg);
	}

private:
	void EnsureNavigated()
	{
		if (_navigated)
			return;
		if (!_htmlView)
			_htmlView = static_cast<HtmlViewerCustomGui*>(
				FindCustomGui(ID_HOST_HTMLVIEW, CUSTOMGUI_HTMLVIEWER));
		if (!_htmlView)
			return;

		// Register the JS→C++ message callback. The HTML viewer holds
		// a reference to our static callback by function pointer + a
		// user-data pointer (this).
		if (!_msgCallbackRegistered)
		{
			_htmlView->SetWebMessageCallback(&OnWebMessageStatic, ""_s, this);
			_msgCallbackRegistered = true;
		}

		// Build a file:// URL pointing at web/demo.html sitting next
		// to the plugin DLL. Use a Win32 path query because Filename ↔
		// maxon::String conversion gives us backslashes; the file://
		// scheme wants forward slashes.
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksV2Dialog::OnWebMessageStatic,
			&hMod);
		wchar_t dll[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, dll, MAX_PATH);
		// Strip filename → keep "C:\...\shotblocks_v2\".
		wchar_t* lastSlash = wcsrchr(dll, L'\\');
		if (lastSlash) *(lastSlash + 1) = 0;
		wchar_t urlBuf[MAX_PATH + 64];
		swprintf_s(urlBuf, MAX_PATH + 64, L"file:///%sweb/demo.html", dll);
		// Forward-slash everything except the "file:///" prefix.
		for (wchar_t* p = urlBuf + 8; *p; ++p)
			if (*p == L'\\') *p = L'/';
		char utf8[MAX_PATH + 64] = {0};
		WideCharToMultiByte(CP_UTF8, 0, urlBuf, -1, utf8, sizeof(utf8), nullptr, nullptr);
		maxon::String url(utf8);
		_htmlView->SetUrl(url, URL_ENCODING_UTF16);
		_navigated = true;
		GePrint("[Shotblocks/v2] navigated to "_s + url);
	}

	void PostTick()
	{
		if (!_htmlView || !_navigated)
			return;
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return;
		Int32 fps = doc->GetFps();
		Int32 frame = doc->GetTime().GetFrame(fps);
		// Heuristic: "playing" iff EVMSG_TIMECHANGED fired within the
		// last 200ms (C4D 2026 doesn't expose GetPlayMode in C++ or
		// Python; cadence is the substitute).
		Float nowMs = GeGetMilliSeconds();
		bool playing = (nowMs - _lastTimeChangedTickMs) < 200.0;

		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"tick\",\"frame\":%d,\"fps\":%d,\"playing\":%s}",
			(int)frame, (int)fps, playing ? "true" : "false");
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	void OnWebMessage(maxon::String message)
	{
		GePrint("[Shotblocks/v2] JS->C++ message: "_s + message);
		// Minimal JSON parsing — the page only sends {"kind":"ping",...}.
		// Looking for "ping" is enough for the demo.
		Int pos = 0;
		if (message.Find("\"kind\":\"ping\""_s, &pos))
		{
			BaseDocument* doc = GetActiveDocument();
			Int32 frame = doc ? doc->GetTime().GetFrame(doc->GetFps()) : -1;
			char buf[128];
			_snprintf_s(buf, sizeof(buf), _TRUNCATE,
				"{\"kind\":\"pong\",\"frame\":%d}", (int)frame);
			if (_htmlView)
				_htmlView->PostWebMessage(maxon::String(buf));
		}
	}

	static void OnWebMessageStatic(maxon::String message, void* user_data, Bool /*hasError*/)
	{
		if (user_data)
			static_cast<ShotblocksV2Dialog*>(user_data)->OnWebMessage(message);
	}

private:
	HtmlViewerCustomGui* _htmlView;
	bool                 _navigated;
	bool                 _msgCallbackRegistered;
	Float                _lastTimeChangedTickMs;
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
