(function () {
  'use strict';
  const i18n = self.CRSubFix.i18n;
  const rows = [
  ["Local translation is experimental. Short dialogue and idioms can be mistranslated.", "本地翻译为实验功能。简短对白和惯用语可能误译，适合作为免费参考。", "本機翻譯為實驗功能。簡短對白和慣用語可能誤譯，適合作為免費參考。", "ローカル翻訳は実験機能です。短い台詞や慣用句を誤訳する場合があるため、参考としてご利用ください。"],
  ["Test local translation", "测试本地翻译", "測試本機翻譯", "ローカル翻訳をテスト"],
  ["Local translation keeps subtitle text on this device.", "本地翻译的字幕文本不会发送到云端。", "本機翻譯的字幕文字不會傳送至雲端。", "ローカル翻訳の字幕テキストは端末外へ送信されません。"],
  [
    "Browser local translation (no key)",
    "浏览器本地翻译（实验，免 Key）",
    "瀏覽器本機翻譯（實驗，免 Key）",
    "ブラウザー内蔵翻訳（実験版・キー不要）"
  ],
  [
    "Download a language model once, then translate on this device. Keep this settings tab open while translating. Work context and AI analysis are not used by this engine.",
    "首次下载语言模型，之后在本机翻译。翻译期间请保持此设置页打开。此引擎不使用作品资料或 AI 分析。",
    "首次下載語言模型，之後在本機翻譯。翻譯期間請保持此設定頁開啟。此引擎不使用作品資料或 AI 分析。",
    "初回に言語モデルをダウンロードし、端末内で翻訳します。翻訳中はこの設定タブを開いたままにしてください。このエンジンは作品情報や AI 分析を使用しません。"
  ],
  [
    "Prepare local translation",
    "准备本地翻译",
    "準備本機翻譯",
    "ローカル翻訳を準備"
  ],
  [
    "Stop local engine",
    "停止本地引擎",
    "停止本機引擎",
    "ローカルエンジンを停止"
  ],
  [
    "Save local settings",
    "保存本地翻译设置",
    "儲存本機翻譯設定",
    "ローカル設定を保存"
  ],
  [
    "Save settings, then prepare the selected language pair.",
    "先保存设置，再准备所选语言对。原文设为自动时，本地引擎默认准备英语。",
    "先儲存設定，再準備所選語言對。原文設為自動時，本機引擎預設準備英語。",
    "設定を保存してから言語ペアを準備します。原文が自動の場合は英語を準備します。"
  ],
  [
    "Preparing local model. The first download may take several minutes.",
    "正在准备本地模型，首次下载可能需要几分钟。",
    "正在準備本機模型，首次下載可能需要幾分鐘。",
    "モデルを準備中です。初回ダウンロードには数分かかる場合があります。"
  ],
  [
    "Local engine ready. Keep this tab open and return to the player to translate.",
    "本地引擎已就绪。保持此页打开，返回播放器开始翻译。",
    "本機引擎已就緒。保持此頁開啟，返回播放器開始翻譯。",
    "準備完了です。このタブを開いたままプレーヤーに戻り、翻訳を開始してください。"
  ],
  [
    "Local engine stopped. Completed subtitles are kept.",
    "本地引擎已停止，已完成的字幕会保留。",
    "本機引擎已停止，已完成的字幕會保留。",
    "エンジンを停止しました。翻訳済みの字幕は保持されます。"
  ],
  [
    "Local settings loaded. Prepare the engine before translating.",
    "已载入本地翻译设置。开始翻译前请准备引擎。",
    "已載入本機翻譯設定。開始翻譯前請準備引擎。",
    "設定を読み込みました。翻訳前にエンジンを準備してください。"
  ],
  [
    "This browser does not provide local translation. Update your browser or choose another engine.",
    "此浏览器未提供本地翻译，请更新浏览器或手动选择其他引擎。",
    "此瀏覽器未提供本機翻譯，請更新瀏覽器或手動選擇其他引擎。",
    "このブラウザーはローカル翻訳に対応していません。更新するか別のエンジンを選んでください。"
  ],
  [
    "This language pair or device is unavailable for local translation. No cloud request was sent.",
    "此语言对或设备暂不支持本地翻译，未发送云端翻译请求。",
    "此語言對或裝置暫不支援本機翻譯，未傳送雲端翻譯請求。",
    "この言語ペアまたは端末では利用できません。クラウド翻訳は送信していません。"
  ],
  [
    "Model preparation failed. Check your connection and browser support, then retry.",
    "模型准备失败，请检查网络与浏览器支持情况后重试。",
    "模型準備失敗，請檢查網路與瀏覽器支援情況後重試。",
    "モデルの準備に失敗しました。ネットワークとブラウザーの対応状況を確認して再試行してください。"
  ],
  [
    "Local preparation cancelled.",
    "已取消本地模型准备。",
    "已取消本機模型準備。",
    "モデルの準備をキャンセルしました。"
  ],
  [
    "Open Translation settings and prepare local translation. Keep that tab open.",
    "请在翻译设置中准备本地引擎，并保持该设置页打开。",
    "請在翻譯設定中準備本機引擎，並保持該設定頁開啟。",
    "翻訳設定でローカルエンジンを準備し、そのタブを開いたままにしてください。"
  ],
  [
    "Prepare the matching source and target languages in Translation settings.",
    "请在翻译设置中选择与当前任务相同的原文、译文语言并重新准备。",
    "請在翻譯設定中選擇與目前工作相同的原文、譯文語言並重新準備。",
    "翻訳設定で現在の原文・翻訳先と同じ言語ペアを準備してください。"
  ],
  [
    "Local translation timed out. Completed subtitles are kept; retry when ready.",
    "本地翻译超时，已完成字幕会保留，可稍后重试。",
    "本機翻譯逾時，已完成字幕會保留，可稍後重試。",
    "ローカル翻訳がタイムアウトしました。翻訳済み字幕は保持されます。再試行できます。"
  ],
  [
    "Local translation failed. Prepare the engine again in Translation settings.",
    "本地翻译失败，请在翻译设置中重新准备引擎。",
    "本機翻譯失敗，請在翻譯設定中重新準備引擎。",
    "ローカル翻訳に失敗しました。翻訳設定で再度エンジンを準備してください。"
  ],
  [
    "Local translation returned no usable text. Retry when ready.",
    "本地引擎未返回有效译文，请重试。",
    "本機引擎未傳回有效譯文，請重試。",
    "有効な翻訳結果を取得できませんでした。再試行してください。"
  ]
];
  i18n.add(Object.fromEntries(rows.map(([en, hans, hant, ja]) => [en, { en, 'zh-Hans': hans, 'zh-Hant': hant, ja }])));
  i18n.add({ 'Browser local translation (no key)': { en: 'Browser local translation (experimental, no key)' } });
  self.CRSubFix.localErrors = {
  "LOCAL_UNSUPPORTED": "This browser does not provide local translation. Update your browser or choose another engine.",
  "LOCAL_UNAVAILABLE": "This language pair or device is unavailable for local translation. No cloud request was sent.",
  "LOCAL_DOWNLOAD_FAILED": "Model preparation failed. Check your connection and browser support, then retry.",
  "LOCAL_CANCELLED": "Local preparation cancelled.",
  "LOCAL_NOT_READY": "Open Translation settings and prepare local translation. Keep that tab open.",
  "LOCAL_LANGUAGE": "Prepare the matching source and target languages in Translation settings.",
  "LOCAL_TIMEOUT": "Local translation timed out. Completed subtitles are kept; retry when ready.",
  "LOCAL_FAILED": "Local translation failed. Prepare the engine again in Translation settings.",
  "LOCAL_INVALID_OUTPUT": "Local translation returned no usable text. Retry when ready."
};
  if (self.location?.protocol === 'chrome-extension:') {
    i18n.ready.then(() => i18n.localize(document.body));
    i18n.watch(() => i18n.localize(document.body));
  }
})();

