// macOS trackpad pinch-to-zoom capture. C4D delivers two-finger SCROLL to
// the embedded WKWebView as DOM wheel events, but PINCH never reaches the
// page: WebKit doesn't surface -magnifyWithEvent: to JavaScript, and C4D
// routes the magnify gesture to the native viewport, not our WebView-
// hosting dialog (verified — BFM_INPUT_MAGNIFY never reaches Message()).
// So we tap AppKit's event stream directly with a local magnify monitor,
// mirroring the NSEvent/AppKit pattern already used by sb_cursor_mac.mm.
//
// Kept out of main.cpp: AppKit headers collide with cinema:: names under
// `using namespace cinema` (same reason as sb_cursor_mac.mm).
#ifdef __APPLE__

#import <AppKit/AppKit.h>

// Forward magnify deltas to C++. magnification is AppKit's per-event zoom
// delta (positive = pinch open = zoom in), typically small (~0.01-0.1).
typedef void (*SbMagnifyCallback)(double magnification);

static SbMagnifyCallback g_cb = nullptr;
static void*             g_handle = nullptr;
static id                g_monitor = nil;

// Resolve the dialog's NSWindow from GeDialog::GetWindowHandle() (Windows-
// centric API; on Mac it hands back an AppKit object). Same helper shape
// as sb_cursor_mac.mm.
static NSWindow* WindowFromHandle(void* handle)
{
	if (!handle)
		return nil;
	id obj = (__bridge id)handle;
	if ([obj isKindOfClass:[NSWindow class]])
		return (NSWindow*)obj;
	if ([obj isKindOfClass:[NSView class]])
		return ((NSView*)obj).window;
	return nil;
}

// Install (callback != null) or remove (callback == null) a local monitor
// for trackpad magnify events. Called on the main thread. Only pinches
// over OUR dialog window are consumed + forwarded; pinches elsewhere
// (e.g. the C4D viewport) pass through so their native zoom still works.
void SbSetMagnifyMonitorMac(SbMagnifyCallback callback, void* dialogHandle)
{
	g_cb = callback;
	g_handle = dialogHandle;
	if (g_monitor)
	{
		[NSEvent removeMonitor:g_monitor];
		g_monitor = nil;
	}
	if (!callback)
		return;
	g_monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMagnify
		handler:^NSEvent* (NSEvent* event)
		{
			NSWindow* win = WindowFromHandle(g_handle);
			if (win && event.window == win)
			{
				if (g_cb)
					g_cb((double)event.magnification);
				return nil;   // consume — we drive the zoom ourselves
			}
			return event;     // not our window — let C4D handle it
		}];
}

#endif
