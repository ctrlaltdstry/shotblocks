// macOS warp-cursor isolated in its own TU: CoreGraphics pulls in
// Apple's MacTypes.h whose global UInt/Int typedefs collide with the
// cinema:: ones under `using namespace cinema` in main.cpp.
#ifdef __APPLE__

#include <CoreGraphics/CoreGraphics.h>

void SbWarpCursorMac(double x, double y);  // -Werror=missing-prototypes

void SbWarpCursorMac(double x, double y)
{
	CGWarpMouseCursorPosition(CGPointMake((CGFloat)x, (CGFloat)y));
	// Without re-associating, the OS suppresses mouse movement for a
	// beat after a warp and the drag stalls.
	CGAssociateMouseAndMouseCursorPosition(true);
}

#endif
