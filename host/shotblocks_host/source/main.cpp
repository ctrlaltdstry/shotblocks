// Shotblocks C++ UI host.
//
// Uses Cinema 4D 2026's built-in HtmlViewerCustomGui (CUSTOMGUI_HTMLVIEWER)
// to render the web UI inside a dockable GeDialog. Because the HTML
// viewer is a first-party C4D widget, docking, layout, and lifecycle
// all "just work" — no WebView2 hosting, no HWND walking, no parenting.

#include "c4d.h"
#include "c4d_gui.h"
#include "c4d_plugin.h"
#include "c4d_resource.h"
#include "c4d_customgui/customgui_htmlviewer.h"

using namespace cinema;

static const Int32 g_shotblocks_host_hello_cmd_id = 1000006;
static const Int32 g_shotblocks_host_dock_cmd_id  = 1000007;

static const Int32 ID_HOST_GROUP    = 2000;
static const Int32 ID_HOST_HTMLVIEW = 2001;


class ShotblocksHostDialog : public GeDialog
{
public:
	ShotblocksHostDialog() : _htmlView(nullptr), _navigated(false) {}

	Bool CreateLayout() override
	{
		SetTitle("Shotblocks Host (C++)"_s);
		GroupBegin(ID_HOST_GROUP, BFH_SCALEFIT | BFV_SCALEFIT, 1, 0, ""_s, 0);
			_htmlView = AddCustomGui<HtmlViewerCustomGui>(
				ID_HOST_HTMLVIEW, ""_s, BFH_SCALEFIT | BFV_SCALEFIT,
				400, 300, BaseContainer());
		GroupEnd();
		SetTimer(100);
		return true;
	}

	Bool InitValues() override
	{
		SetTimer(100);
		return true;
	}

	void Timer(const BaseContainer& /*msg*/) override
	{
		// The HTML viewer is created lazily; navigate as soon as it exists.
		if (_navigated)
			return;
		if (!_htmlView)
			_htmlView = static_cast<HtmlViewerCustomGui*>(
				FindCustomGui(ID_HOST_HTMLVIEW, CUSTOMGUI_HTMLVIEWER));
		if (!_htmlView)
			return;
		_htmlView->SetUrl("https://example.com/"_s, URL_ENCODING_UTF16);
		_navigated = true;
		SetTimer(0);
		GePrint("[Shotblocks/host] HTML viewer navigated"_s);
	}

private:
	HtmlViewerCustomGui* _htmlView;
	bool                 _navigated;
};


// ---------------------------------------------------------------------------
// Command + registration
// ---------------------------------------------------------------------------

class OpenShotblocksHostDialogCommand : public CommandData
{
public:
	OpenShotblocksHostDialogCommand() : _dlg(nullptr) {}

	Bool Execute(BaseDocument* /*doc*/, GeDialog* /*parentManager*/) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksHostDialog);
		if (!_dlg)
			return false;
		return _dlg->Open(DLG_TYPE::ASYNC, g_shotblocks_host_dock_cmd_id, -1, -1, 700, 400);
	}

	Bool RestoreLayout(void* secret) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksHostDialog);
		if (!_dlg)
			return false;
		return _dlg->RestoreLayout(g_shotblocks_host_dock_cmd_id, 0, secret);
	}

private:
	ShotblocksHostDialog* _dlg;
};


class ShotblocksHelloCommand : public CommandData
{
public:
	Bool Execute(BaseDocument* /*doc*/, GeDialog* /*parentManager*/) override
	{
		GePrint("[Shotblocks/host] hello from C++ at plugin id " + String::IntToString(g_shotblocks_host_hello_cmd_id));
		return true;
	}
};


static Bool RegisterShotblocksHostCommands()
{
	if (!RegisterCommandPlugin(
		g_shotblocks_host_hello_cmd_id,
		"Shotblocks Host (C++ hello)"_s,
		0, nullptr,
		"Hello command"_s,
		NewObjClear(ShotblocksHelloCommand)))
		return false;

	if (!RegisterCommandPlugin(
		g_shotblocks_host_dock_cmd_id,
		"Open Shotblocks Host (C++ dialog)"_s,
		0, nullptr,
		"Dockable GeDialog hosting C4D's built-in HTML viewer"_s,
		NewObjClear(OpenShotblocksHostDialogCommand)))
		return false;

	return true;
}


Bool cinema::PluginStart()
{
	if (!RegisterShotblocksHostCommands())
		return false;
	GePrint("[Shotblocks/host] PluginStart OK"_s);
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
