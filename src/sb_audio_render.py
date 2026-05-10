"""Waveform drawing for the v7 audio subsystem.

Pure-function rendering. No `c4d` import — the renderer accepts a
`draw_target` that quacks like `GeUserArea`, needing only:

    draw_target.DrawSetPen(rgb_vector)
    draw_target.DrawLine(x1, y1, x2, y2)
    draw_target.DrawRectangle(x1, y1, x2, y2)        # for the body fill

This keeps the math testable without C4D and obeys the v7 task's
"pure-function waveform drawing" requirement. The renderer redraws
procedurally per `DrawMsg` (no bitmap caching for v7); we draw one
vertical line per pixel column from the peak cache slice.
"""


def draw_waveform(draw_target, peaks, rect, *,
                  fg_rgb, mid_rgb=None, x_offset=0):
    """Render `peaks` (a list of (min, max) tuples in [-1, 1]) into the
    rectangle `rect = (x1, y1, x2, y2)` on `draw_target`.

    One peak entry maps to one pixel column starting at `rect[0] + x_offset`
    and advancing by 1 px each. Columns past `rect[2]` are clipped.
    Vertical center is the midpoint of [y1, y2]. Each column is drawn
    as a single vertical line from min*halfH to max*halfH about the
    centerline.

    Args:
        draw_target: object with DrawSetPen / DrawLine.
        peaks: list of (min, max) floats in [-1, 1].
        rect: (x1, y1, x2, y2) in canvas pixels — the body region.
        fg_rgb: c4d.Vector — line color for the waveform.
        mid_rgb: optional c4d.Vector — center reference line. None = skip.
        x_offset: int — start drawing peaks this many pixels in from rect[0].
                  Used when only part of a clip's waveform should render
                  (e.g. when the clip's left edge is off-screen).

    No-ops cleanly when peaks is empty or the rect has zero area.
    """
    x1, y1, x2, y2 = rect
    if x2 <= x1 or y2 <= y1 or not peaks:
        return

    cy     = (y1 + y2) // 2
    half_h = max(1, (y2 - y1) // 2 - 1)  # one-pixel inset top/bottom

    if mid_rgb is not None:
        draw_target.DrawSetPen(mid_rgb)
        draw_target.DrawLine(x1, cy, x2, cy)

    draw_target.DrawSetPen(fg_rgb)
    start_x = x1 + x_offset
    # Iterate by index so we can break early on x > x2 — peaks may be
    # longer than the on-screen region.
    n = len(peaks)
    max_x = x2
    for i in range(n):
        x = start_x + i
        if x < x1:
            continue
        if x > max_x:
            break
        mn, mx = peaks[i]
        # Map [-1, 1] to pixel offsets about cy.
        # Y axis grows downward in canvas coords; positive sample
        # value points UP (negative offset). Do the math accordingly.
        y_top    = cy - int(mx * half_h)
        y_bottom = cy - int(mn * half_h)
        if y_top == y_bottom:
            # Pure silence on this column — render the centerline pixel
            # so the waveform reads as a continuous line rather than a
            # gap.
            draw_target.DrawLine(x, cy, x, cy)
        else:
            draw_target.DrawLine(x, y_top, x, y_bottom)


def map_audio_frames_to_columns(audio_frame_start, audio_frame_end,
                                samples_per_column):
    """Convert an audio-frame range to peak-cache column indices.

    Helper used by the canvas when it knows the visible frame window
    (in audio frames) and wants to ask `slice_peaks` for that exact
    span. Returns `(col_start, col_end)`.
    """
    if samples_per_column < 1:
        samples_per_column = 1
    col_start = audio_frame_start // samples_per_column
    col_end   = (audio_frame_end + samples_per_column - 1) // samples_per_column
    if col_end < col_start:
        col_end = col_start
    return col_start, col_end
