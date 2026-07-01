---
"@javargasm/opencode-kiro-auth": minor
---

Update Kiro CLI compatibility and model catalog metadata.

- Align Kiro management `ListAvailableModels`/`ListAvailableProfiles` headers with Kiro CLI 2.10.0 while keeping `X-Amz-Target` method-specific.
- Send the captured `ListAvailableModels` body with `origin` and `profileArn`.
- Add newer Kiro models (`claude-sonnet-5`, `deepseek-3.2`, `glm-5`) to the fallback catalog.
- Show each model's `rateMultiplier` next to its display name for both dynamic endpoint models and fallback models.
- Add direct regression tests for catalog rate multipliers and management request headers/body.
