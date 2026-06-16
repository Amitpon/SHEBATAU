# Calibration plots

Drop a calibration plot image per lab here and it appears automatically in the
**Performance** section of the app (served at `/calibration/...`).

## Naming
- By lab name: `Creatinine.png`, `Sodium.png`, `HGB.png`
- Or by model key for sex-specific labs: `HGB_M.png`, `HGB_F.png`, `CPK_M.png`
- Accepted formats: `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`

The backend matches a file whose name equals the lab (case-insensitive) or starts
with `<lab>` / `<lab>_`. No code change needed - just add the files.
