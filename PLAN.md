# Plan: Voice & Model Selection on Job Create Form

## Context

The job create form (`JobCreateForm`) currently only accepts title, text, and a file upload. The user can't choose which voice or model to use — both default to server-side settings (`default_voice_id: "suzy"`, `default_model_id: "Qwen/Qwen3-TTS-12Hz-0.6B-Base"`).

We want to add two dropdowns to the form:
1. **Voice selector** — list all voices from the registry (currently `suzy` and `howard`)
2. **Model selector** — let the user pick between the small (0.6B) and large (1.7B) models

## Approach

### Backend: Add `model_id` to job creation
The `/api/jobs` endpoint already accepts a `voice_id` form field. We just need to add a `model_id` form field.

**Files to modify:**
- `server/app/api/router.py` — add `model_id: str | None = Form(default=None)` to `create_job`, and use it if provided (fall back to `default_model_id`)

### Frontend: Voice + Model dropdowns in JobCreateForm
The frontend already has `api.listVoices()` available. We'll:
1. Fetch voices on mount and store them in state
2. Define the available model options (0.6B and 1.7B)
3. Render `<select>` dropdowns for both
4. Append `voice_id` and `model_id` to the FormData on submit

**Files to modify:**
- `web/src/features/jobs/JobCreateForm.tsx` — add voice/model selects, fetch voices, submit form fields
- `web/src/features/jobs/JobCreateForm.test.tsx` — update tests for new form fields

### Available model options
Hardcoded list (aligned with Qwen3-TTS models):
- `Qwen/Qwen3-TTS-12Hz-0.6B-Base` — "Small (0.6B)"
- `Qwen/Qwen3-TTS-12Hz-1.7B-Base` — "Large (1.7B)"

## Reuse
- `api.listVoices()` — already implemented in `web/src/lib/api.ts`
- `app.voices.registry.VoiceRegistry.list_voices()` — already loads voices from `server/voices/`
- `RuntimeConfig.default_model_id` / `default_voice_id` — serve as fallbacks
- Existing select/input UI patterns from other forms in the codebase

## Steps
- [ ] Backend: Add `model_id` Form parameter to `create_job` endpoint in `server/app/api/router.py`
- [ ] Frontend: Fetch voices in `JobCreateForm` using `api.listVoices()`
- [ ] Frontend: Add voice `<select>` dropdown to `JobCreateForm`
- [ ] Frontend: Define model options and add model `<select>` dropdown
- [ ] Frontend: Send `voice_id` and `model_id` in FormData on submit
- [ ] Update `JobCreateForm.test.tsx` to cover new fields

## Verification
1. `cd server && uv run pytest` — backend tests pass
2. `cd web && npm test` — frontend tests pass
3. Manual: Start the app, go to the jobs page, verify voice and model dropdowns are visible and populated correctly, submit a job and confirm it uses the selected values
