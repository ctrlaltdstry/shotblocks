// macOS native cursor layer — the Mac counterpart of the Win32
// WM_SETCURSOR subclass + fast-timer re-assert in main.cpp. C4D's own
// event handling keeps resetting NSCursor (same war WebView2 fought on
// Windows), so a CSS cursor alone flickers or loses entirely. While a
// tool-cursor mode is on, a 16ms GCD timer on the main thread keeps
// re-asserting the tool cursor; [NSCursor set] is process-global, so
// the assert is gated on the pointer actually being over the dialog
// window (when the dialog's NSWindow is resolvable from the GeDialog
// window handle).
//
// Kept out of main.cpp: AppKit headers collide with cinema:: names
// under `using namespace cinema` (same reason as warp_cursor_mac.cpp).
#ifdef __APPLE__

#import <AppKit/AppKit.h>

#include <string>
#include <unordered_map>

void SbSetCursorModeMac(const char* name, const char* cursorsDirUtf8, void* dialogHandle);

static NSCursor* CursorFor(const std::string& dir, const std::string& name)
{
	// System-cursor overrides — modes that read better as the native
	// macOS cursor than as the custom art (and must agree with the CSS
	// layer's choice for the same mode, or the two writers flicker).
	// play-range pairs with CSS ew-resize, which WebKit renders as the
	// plain "< >" — NOT the public resizeLeftRightCursor (that's the
	// splitter-style "<|>"). Load the same HIServices resource WebKit
	// uses so the two layers are pixel-identical.
	if (name == "play-range")
	{
		static NSCursor* ew = nil;
		if (!ew)
		{
			NSString* base = @"/System/Library/Frameworks/ApplicationServices.framework/Versions/A/"
				"Frameworks/HIServices.framework/Versions/A/Resources/cursors/resizeeastwest";
			NSImage* img = [[NSImage alloc] initWithContentsOfFile:
				[base stringByAppendingPathComponent:@"cursor.pdf"]];
			NSDictionary* info = [NSDictionary dictionaryWithContentsOfFile:
				[base stringByAppendingPathComponent:@"info.plist"]];
			if (img && img.size.width > 0 && info)
				ew = [[NSCursor alloc] initWithImage:img
					hotSpot:NSMakePoint([info[@"hotx"] doubleValue], [info[@"hoty"] doubleValue])];
			else
				ew = [NSCursor resizeLeftRightCursor];
		}
		return ew;
	}

	static std::unordered_map<std::string, NSCursor*> cache;
	auto it = cache.find(name);
	if (it != cache.end())
		return it->second;
	NSString* path = [NSString stringWithUTF8String:(dir + name + ".png").c_str()];
	NSImage* img = [[NSImage alloc] initWithContentsOfFile:path];
	NSCursor* c = nil;
	if (img && img.size.width > 0)
	{
		// Display at 32pt regardless of source resolution (the source
		// PNGs are high-res exports; retina picks the sharp pixels).
		const CGFloat scale = 32.0 / MAX(img.size.width, img.size.height);
		const NSSize sz = NSMakeSize(img.size.width * scale, img.size.height * scale);
		[img setSize:sz];
		// Hotspot center — matches the CSS layer's `16 16` and the
		// make-cursor.mjs default the Windows .cur files were built with.
		c = [[NSCursor alloc] initWithImage:img hotSpot:NSMakePoint(sz.width / 2, sz.height / 2)];
	}
	cache[name] = c;  // nil cached too: missing file = never force
	return c;
}

// Resolve the dialog's NSWindow from GeDialog::GetWindowHandle(),
// which is documented Windows-centric (HWND) — on Mac it hands back
// some AppKit object; accept NSWindow or NSView.
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

static dispatch_source_t g_timer = nil;
static NSCursor*         g_active = nil;
static NSWindow*         g_window = nil;

void SbSetCursorModeMac(const char* name, const char* cursorsDirUtf8, void* dialogHandle)
{
	// Called on the main thread (command dispatch).
	g_window = WindowFromHandle(dialogHandle);
	NSCursor* c = (name && *name) ? CursorFor(cursorsDirUtf8, name) : nil;
	g_active = c;
	if (!c)
	{
		if (g_timer)
		{
			dispatch_source_cancel(g_timer);
			g_timer = nil;
		}
		[[NSCursor arrowCursor] set];
		return;
	}
	[c set];
	if (!g_timer)
	{
		g_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
		dispatch_source_set_timer(g_timer, DISPATCH_TIME_NOW, 16 * NSEC_PER_MSEC, 4 * NSEC_PER_MSEC);
		dispatch_source_set_event_handler(g_timer, ^{
			if (!g_active)
				return;
			// Only force while the pointer is over the dialog window —
			// approximates the Windows HTCLIENT hit-test so the rest of
			// C4D keeps its own cursors. No window resolved = force
			// anyway (JS drops the mode when the pointer leaves its
			// hover zones).
			if (g_window)
			{
				const NSPoint p = [NSEvent mouseLocation];
				if (!NSPointInRect(p, g_window.frame))
					return;
			}
			[g_active set];
		});
		dispatch_resume(g_timer);
	}
}

#endif
