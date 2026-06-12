# Manual CMakeLists for shotblocks. This shadows the auto-generated
# one in the build dir (per the note Maxon's tooling prints in its own
# template).

set(CMAKE_CURRENT_SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR})

include(${MAXON_TOOLING_DIR}/sdk_targets.cmake)
include(${MAXON_TOOLING_DIR}/sdk_compiler_helper.cmake)

# --- general ---
set(maxon_targetName shotblocks)
set(maxon_targetType DLL)
set(maxon_targetFrameworkDependencies
  asset.framework
  cinema.framework
  cinema_hybrid.framework
  core.framework
)
set(maxon_targetPublicCompileDefinitions USE_API_MAXON)
set(maxon_targetPrivateCompileDefinitions
  MAXON_CMAKE_BUILD
  MAXON_MODULE_ID="com.shotblocks"
)
set(maxon_targetPlatforms Win64 OSX)
set(maxon_targetSourceDirectories
  source
)
set(maxon_targetRegisterGeneratedFileNames
  register.cpp
  interface_registration.cpp
)
set(maxon_targetTypeViewerFiles )
set(maxon_additionalDefinitions )
set(maxon_enableRTTI OFF)
set(maxon_enableExceptionHandling OFF)

# --- WINDOWS specific ---
set(maxon_excludeFromBuild.WINDOWS )
set(maxon_exclude.WINDOWS )
set(maxon_additionalDefinitions.WINDOWS )

# Using C4D's built-in HtmlViewerCustomGui — no WebView2 dependency.
set(maxon_linkLibraries.WINDOWS.DEBUG   )
set(maxon_linkLibraries.WINDOWS.RELEASE )
set(maxon_linkLibraries.WINDOWS.ARM     )

set(maxon_additionalIncludeDirectories.WINDOWS )
set(maxon_additionalIncludeDirectories.WINDOWS.ARM )

set(maxon_additionalLinkDirectories.WINDOWS )
set(maxon_additionalLinkDirectories.WINDOWS.DEBUG )
set(maxon_additionalLinkDirectories.WINDOWS.RELEASE )
set(maxon_additionalLinkDirectories.WINDOWS.ARM )
set(maxon_additionalSourceFiles.WINDOWS )
set(maxon_prebuildEvents.WINDOWS.DEBUG [=[]=])
set(maxon_prebuildEvents.WINDOWS.RELEASE [=[]=])
set(maxon_subsystem.WINDOWS WINDOWS)

# --- MACOS / LINUX ---
set(maxon_excludeFromBuild.MACOS )
set(maxon_exclude.MACOS )
set(maxon_additionalDefinitions.MACOS )
set(maxon_linkLibraries.MACOS.DEBUG )
set(maxon_linkLibraries.MACOS.RELEASE )
set(maxon_additionalIncludeDirectories.MACOS )
# CoreGraphics (CGWarpMouseCursorPosition) comes from the build script's
# global -framework linker flags — maxon_linkFrameworks emits -l<name>
# under the Ninja generator, which the linker can't resolve.
set(maxon_linkFrameworks.MACOS )
set(maxon_additionalSourceFiles.MACOS )
set(maxon_prebuildEvents.MACOS.DEBUG [=[]=])
set(maxon_prebuildEvents.MACOS.RELEASE [=[]=])

set(maxon_excludeFromBuild.LINUX )
set(maxon_exclude.LINUX )
set(maxon_additionalDefinitions.LINUX )
set(maxon_linkLibraries.LINUX.DEBUG )
set(maxon_linkLibraries.LINUX.RELEASE )
set(maxon_additionalSourceFiles.LINUX )
set(maxon_systemIncludePaths )
set(maxon_additionalLinkDirectories.LINUX.DEBUG )
set(maxon_additionalLinkDirectories.LINUX.RELEASE )
set(maxon_additionalIncludeDirectories.LINUX )
set(maxon_prebuildEvents.LINUX.DEBUG [=[]=])
set(maxon_prebuildEvents.LINUX.RELEASE [=[]=])

# --- Compiler specific ---
set(maxon_additionalCompileOptions.MSVC.CPP )
set(maxon_additionalCompileOptions.MSVC.C )
set(maxon_additionalCompileOptions.GNU.C )
set(maxon_additionalCompileOptions.GNU.CPP )
set(maxon_additionalCompileOptions.CLANG.C )
set(maxon_additionalCompileOptions.CLANG.CPP )

# --- Linker specific ---
set(maxon_additionalLinkerOptions.MSVC.DEBUG )
set(maxon_additionalLinkerOptions.MSVC.RELEASE )
set(maxon_additionalLinkerOptions.CLANG.DEBUG )
set(maxon_additionalLinkerOptions.CLANG.RELEASE )

set(maxon_targetFrameworkDependencies ${maxon_targetFrameworkDependencies} PARENT_SCOPE)

MaxonTargets_ProcessCinemaTargetVars()
