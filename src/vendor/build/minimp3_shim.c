/* minimp3_shim.c — thin C wrapper around minimp3_ex for ctypes.
 *
 * Exposes two stable extern "C" entry points:
 *
 *   int sb_mp3_decode_file(
 *       const wchar_t* path,
 *       int16_t**      out_samples,    // malloc'd via minimp3 (free with sb_mp3_free)
 *       size_t*        out_n_samples,  // total int16 count = frames * channels
 *       int*           out_sample_rate,
 *       int*           out_n_channels);
 *
 *   void sb_mp3_free(void* p);
 *
 * Returns 0 on success, negative MP3D_E_* code on failure (see minimp3_ex.h),
 * or -100 if the file couldn't be opened (Unicode path included).
 *
 * Built as a self-contained DLL — no CRT exports beyond malloc/free that
 * minimp3 itself uses. Caller (Python) must call sb_mp3_free() on
 * out_samples once the bytes have been copied out, otherwise the buffer
 * leaks.
 */

#define MINIMP3_IMPLEMENTATION
/* int16 output — matches the WAV path. minimp3 selects int16 when
 * MINIMP3_FLOAT_OUTPUT is *not defined at all* — `#define ... 0`
 * still counts as defined (the header tests with #ifndef), so the
 * macro must stay absent here. Defining it as 0 produced a float32
 * buffer that the wrapper read as int16, sounded like static, and
 * passed every length sanity check by coincidence. Don't add it back. */

#include "minimp3.h"
#include "minimp3_ex.h"

#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define SB_E_OPEN  -100

#ifdef __cplusplus
extern "C" {
#endif

__declspec(dllexport)
int sb_mp3_decode_file(
    const wchar_t* path,
    int16_t**      out_samples,
    size_t*        out_n_samples,
    int*           out_sample_rate,
    int*           out_n_channels)
{
    if (!path || !out_samples || !out_n_samples ||
        !out_sample_rate || !out_n_channels) {
        return MP3D_E_PARAM;
    }

    *out_samples     = NULL;
    *out_n_samples   = 0;
    *out_sample_rate = 0;
    *out_n_channels  = 0;

    /* Open with _wfopen so non-ASCII paths work. */
    FILE* fp = _wfopen(path, L"rb");
    if (!fp) {
        return SB_E_OPEN;
    }

    if (fseek(fp, 0, SEEK_END) != 0) { fclose(fp); return SB_E_OPEN; }
    long file_size_l = ftell(fp);
    if (file_size_l < 0) { fclose(fp); return SB_E_OPEN; }
    if (fseek(fp, 0, SEEK_SET) != 0) { fclose(fp); return SB_E_OPEN; }

    size_t file_size = (size_t)file_size_l;
    uint8_t* file_buf = (uint8_t*)malloc(file_size);
    if (!file_buf) { fclose(fp); return MP3D_E_MEMORY; }

    size_t got = fread(file_buf, 1, file_size, fp);
    fclose(fp);
    if (got != file_size) {
        free(file_buf);
        return SB_E_OPEN;
    }

    mp3dec_t dec;
    mp3dec_init(&dec);
    mp3dec_file_info_t info;
    memset(&info, 0, sizeof(info));

    int rc = mp3dec_load_buf(&dec, file_buf, file_size, &info, NULL, NULL);
    free(file_buf);

    if (rc != 0) {
        if (info.buffer) free(info.buffer);
        return rc;
    }

    *out_samples     = (int16_t*)info.buffer; /* caller frees via sb_mp3_free */
    *out_n_samples   = info.samples;
    *out_sample_rate = info.hz;
    *out_n_channels  = info.channels;
    return 0;
}

__declspec(dllexport)
void sb_mp3_free(void* p)
{
    if (p) free(p);
}

#ifdef __cplusplus
}
#endif
