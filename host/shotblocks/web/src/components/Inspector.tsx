/** Right-side Inspector panel — always visible at a fixed 250px width
 *  (per Figma node 365:668). Will host the Render / Motion tab strip
 *  + section content as v1 Plan 2 lands. Tab strip is hidden in v1
 *  until motion layers ship (Commit 6); render sections fill in
 *  Commits 8+.
 *
 *  Empty for now — the previous Audio settings have moved to the
 *  SettingsPanel modal (gear icon in the utility strip).
 */
export function Inspector() {
  return (
    <div className="inspector">
      <div className="inspector__body" />
    </div>
  );
}
