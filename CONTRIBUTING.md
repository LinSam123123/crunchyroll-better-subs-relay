# Contributing / 参与改进 / 貢献

Please read AGENTS.md for architecture, safety boundaries and verification commands. Small fixes with focused synthetic tests are easier to review than unrelated refactors.

Issues: include version, browser, steps, expected behavior and a sanitized error. Do not attach keys, cookies, complete subtitle files, browser profiles or raw API logs. If a secret is exposed, revoke it first; do not paste it again as proof.

Pull requests: explain the behavior change and tests; preserve original notices, provider attribution, opt-in paid calls and strict release/episode selection. No automatic switch of subtitle versions, broadened permissions or hidden telemetry.

Before publishing: `npm ci`, `npm run verify`, `npm run privacy`, relevant isolated browser tests, and `npm run package`. Review all changed files and reachable history; automated scanners do not replace human review. Keep private test inputs and credentials outside this repository.

欢迎用中文、日语、英文或韩语反馈。请描述能复现的步骤，不要上传完整字幕或 Key。
中国語・日本語・英語での報告を歓迎します。再現手順を記載し、字幕全文やキーは添付しないでください。
한국어 제보도 환영합니다. 재현 순서를 적고, 자막 전체나 키는 첨부하지 마세요.
