# Calibration scripts

Fit the colour and lens parameters in `profiles/*.toml` against Apple reference renders. These are
development tools (Python 3 + numpy + scipy); they are not run by `cargo test`.

```bash
python3 -m venv /tmp/rd-venv && /tmp/rd-venv/bin/pip install numpy scipy
export RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures RAW_DEVELOP_REFS=~/raw-develop-refs
export RAW_DEVELOP_PROFILE=../../profiles/fujifilm-x-e5.toml   # colour matrices + white level used by the fits
/tmp/rd-venv/bin/python fit_color.py        # baseline_exposure, look_matrix_1/2 (writes $RAW_DEVELOP_CALIB_OUT/colorfit3.json)
/tmp/rd-venv/bin/python fit_distortion.py DSCF0604   # check distortion_fill_scale
```

| Script | Fits |
|---|---|
| `paths.py` | Env-configured paths; per-fixture metadata via exiftool; minimal profile reader |
| `fit.py` | Shared loaders: CFA block means and reference `.f32` images |
| `dng.py` | DNG colour model (Adobe ColorMatrix/ForwardMatrix, CCT interpolation) |
| `fit2.py` | Selects smooth, unclipped sample blocks per fixture |
| `fit4.py` | Shared data loading for the joint colour fit |
| `fit_color.py` | Exposure offset and two white-preserving P3 look matrices (with the 0.003 black-render offset) |
| `fit_tone.py`, `tone.py` | Obsolete: fitted the old per-channel tone curve. The look is now a port of RawCamera's kernels (`stages/look.rs`), so they are no longer used |
| `fit_distortion.py` | Checks Fuji distortion params against Apple's lens-corrected capture |

Results are our own fitted numbers. The profile's `[[noise]]` tables are not fitted: they
are transcribed from RawCamera render graphs (`graph.txt`, see
`../../docs/adding-a-camera.md#8-transcribe-the-noise-tables`).

See `../../docs/validation.md` and `../../docs/adding-a-camera.md`.
