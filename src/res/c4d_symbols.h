#ifndef C4D_SYMBOLS_H__
#define C4D_SYMBOLS_H__

// Plugin-wide symbol enum. Required by C4D's resource subsystem even if empty;
// without this file, RegisterTagPlugin(description=...) fails with
// "Could not initialize global resource for the plugin."
enum
{
    _SHOTBLOCKS_DUMMY_ = 10000,
};

#endif
