(function () {
  'use strict';
  const i18n = self.CRSubFix.i18n;
  const rows = [
  [
    "当前版本快速入门",
    "目前版本快速入門",
    "Quick start for this version",
    "現行版のクイックスタート"
  ],
  [
    "先在 Crunchyroll 打开一集，等待字幕菜单出现。播放器字幕按钮旁的 ▾ 是选择字幕、外部字幕和作品资料的入口；浏览器工具栏弹窗用于界面语言、字幕样式和翻译设置。",
    "先在 Crunchyroll 開啟一集，等待字幕選單出現。播放器字幕按鈕旁的 ▾ 是選擇字幕、外部字幕和作品資料的入口；瀏覽器工具列彈窗用於介面語言、字幕樣式和翻譯設定。",
    "Open an episode on Crunchyroll and wait for the subtitle menu. Use ▾ beside the player's subtitle button to choose tracks, external subtitles or work details. The browser toolbar popup contains UI language, subtitle appearance and translation settings.",
    "Crunchyroll でエピソードを開き、字幕メニューが表示されるまで待ちます。字幕ボタン横の ▾ から字幕・外部字幕・作品情報を選べます。ブラウザーの拡張ポップアップでは表示言語・字幕スタイル・翻訳設定を変更できます。"
  ],
  [
    "有想要的官方字幕：直接选择语言，也可以搭配第二字幕进行双语观看。",
    "有想要的官方字幕：直接選擇語言，也可以搭配第二字幕進行雙語觀看。",
    "Official subtitles available? Select the language, or add a second track for bilingual viewing.",
    "公式字幕がある場合：言語を選択します。第二字幕を追加すると二言語で視聴できます。"
  ],
  [
    "没有合适的官方字幕：先到「外部字幕」搜索；仍找不到时，再手动启动机器翻译。",
    "沒有合適的官方字幕：先到「外部字幕」搜尋；仍找不到時，再手動啟動機器翻譯。",
    "Missing your language? Search External subtitles first, then manually start machine translation if needed.",
    "希望する公式字幕がない場合：「外部字幕」で検索し、見つからなければ手動で機械翻訳を開始します。"
  ],
  [
    "新版增加了多源字幕搜索、同合集下一集跟随、自选翻译接口、流式边译边看、多语言搜索名、可选 AI 分析和校对导出。",
    "新版增加了多源字幕搜尋、同合集下一集跟隨、自選翻譯介面、串流邊譯邊看、多語言搜尋名稱、可選 AI 分析和校對匯出。",
    "Added features include multiple subtitle providers, collection following, custom translation APIs, streaming translation, multilingual search names, optional AI analysis and proofreading exports.",
    "追加機能：複数の字幕ソース、合集の次話追従、カスタム翻訳 API、ストリーミング翻訳、多言語の検索名、任意の AI 分析、校正用エクスポート。"
  ],
  [
    "外部字幕与合集跟随",
    "外部字幕與合集跟隨",
    "External subtitles and collection following",
    "外部字幕と合集の追従"
  ],
  [
    "1. 从当前播放页打开「外部字幕」，配置要使用的字幕源 Key。assrt 适合找中文字幕，Jimaku 以日文为主，SubDL 提供多语言候选；各来源的覆盖和可用性不同。",
    "1. 從目前播放頁開啟「外部字幕」，設定要使用的字幕源 Key。assrt 適合找中文字幕，Jimaku 以日文為主，SubDL 提供多語言候選；各來源的涵蓋範圍與可用性不同。",
    "1. Open External subtitles from the episode and configure the keys for your chosen providers. assrt is useful for Chinese, Jimaku mainly has Japanese, and SubDL offers multilingual candidates. Coverage and availability vary.",
    "1. 再生ページから「外部字幕」を開き、利用するサービスのキーを設定します。assrt は中国語、Jimaku は主に日本語、SubDL は多言語の候補を提供します。収録範囲や利用状況はサービスごとに異なります。"
  ],
  [
    "2. 核对作品、季和集数，选择搜索名。优先参考可获取的官方多语言名，也可离线简繁转换；结果少时换英文名或日文名再搜。AI 名称分析是可选的，需要支持分析的模型接口，DeepL 用户可以跳过。",
    "2. 核對作品、季和集數，選擇搜尋名稱。優先參考可取得的官方多語言名稱，也可離線簡繁轉換；結果少時換英文名或日文名再搜。AI 名稱分析為選用功能，需要支援分析的模型介面，DeepL 使用者可以略過。",
    "2. Check the title, season and episode, then choose a search name. Use available official localized names or offline Chinese script conversion. Try English or Japanese if results are sparse. Optional AI name analysis needs a compatible model API; DeepL users can skip it.",
    "2. 作品・シーズン・話数を確認して検索名を選びます。取得できた公式の多言語名やオフラインの簡繁変換を使い、結果が少なければ英語名・日本語名も試します。任意の AI 名称分析には対応モデル API が必要です。DeepL のみでも検索できます。"
  ],
  [
    "3. 按「目录 → 发布版本 → 当前集文件」选择，先预览再加载。相同集数可能属于不同字幕组、WEB／BD 或修订版，不要只看集数。也可以导入本地字幕文件。",
    "3. 按「目錄 → 發布版本 → 目前集數檔案」選擇，先預覽再載入。相同集數可能屬於不同字幕組、WEB／BD 或修訂版，不要只看集數。也可以匯入本機字幕檔案。",
    "3. Choose a directory, release version and episode file, preview it, then load it. The same episode can have different groups, WEB/BD cuts or revisions. Check the release too. Local subtitle import is also available.",
    "3. ディレクトリ → リリース版 → 現在の話数のファイルの順に選択し、プレビュー後に読み込みます。同じ話数でも字幕グループ・WEB/BD・改訂版が異なる場合があります。ローカル字幕の読み込みも可能です。"
  ],
  [
    "4. 要连续观看同一套字幕，勾选「跟随此字幕合集」后再「加载到播放器」。下一集会尝试匹配已确认的作品、季和发布版本，并继承该合集的延迟；缺集、特别篇或匹配不明确时需手动选择。",
    "4. 要連續觀看同一套字幕，勾選「跟隨此字幕合集」後再「載入到播放器」。下一集會嘗試匹配已確認的作品、季和發布版本，並繼承該合集的延遲；缺集、特別篇或匹配不明確時需手動選擇。",
    "4. Enable Follow this subtitle collection before Load into player. The next episode attempts to match the confirmed title, season and release, retaining the collection's offset. Missing episodes, specials and ambiguous matches need manual selection.",
    "4.「この字幕合集に追従」を有効にしてからプレーヤーに読み込みます。次話では確認済みの作品・シーズン・リリース版で照合し、合集の遅延設定も引き継ぎます。欠番・特別編・曖昧な候補は手動で選択してください。"
  ],
  [
    "字幕提前或落后时，以对白为准微调延迟，每次可调 0.1 秒。BD 与 WEB 的剪辑可能不同；如果前面同步、后面仍错位，单一延迟无法解决，优先换更接近当前片源的版本。",
    "字幕提前或落後時，以對白為準微調延遲，每次可調 0.1 秒。BD 與 WEB 的剪輯可能不同；如果前面同步、後面仍錯位，單一延遲無法解決，優先換更接近目前片源的版本。",
    "If subtitles are early or late, adjust timing against dialogue in 0.1-second steps. BD and WEB edits may differ. If only part of the episode matches, a single offset cannot fix it; try a release closer to your video.",
    "字幕が早い・遅い場合は、台詞に合わせて 0.1 秒刻みで調整します。BD と WEB では編集が異なることがあります。途中からずれる場合は一定の遅延では直せないため、映像に近い版を選んでください。"
  ],
  [
    "字幕服务由 assrt.net 提供（使用该来源时）。",
    "字幕服務由 assrt.net 提供（使用該來源時）。",
    "Subtitle service provided by assrt.net when using that source.",
    "assrt.net 利用時の字幕サービス提供：assrt.net。"
  ],
  [
    "机器翻译与边译边看",
    "機器翻譯與邊譯邊看",
    "Machine translation as you watch",
    "翻訳しながら視聴"
  ],
  [
    "打开翻译设置",
    "開啟翻譯設定",
    "Open translation settings",
    "翻訳設定を開く"
  ],
  [
    "1. 选择 DeepL 或自选 OpenAI 兼容接口。自选接口需填写 Base URL、Key、模型和服务支持的协议；这些服务与额度由你自行提供。",
    "1. 選擇 DeepL 或自選 OpenAI 相容介面。自選介面需填寫 Base URL、Key、模型和服務支援的協定；這些服務與額度由你自行提供。",
    "1. Choose DeepL or your own OpenAI-compatible API. For a custom provider, enter its Base URL, key, model and supported protocol. You supply the service account and quota.",
    "1. DeepL または OpenAI 互換 API を選択します。カスタム API には Base URL・キー・モデル・対応プロトコルを設定します。サービスのアカウントと利用枠は各自で用意してください。"
  ],
  [
    "2. 回到当前集的字幕菜单，选择源字幕和目标语言，再启动翻译。支持流式的接口可开启流式输出：已完成的字幕先显示，不必等整集完成；跳到尚未译完的位置仍需等待。",
    "2. 回到目前集數的字幕選單，選擇來源字幕和目標語言，再啟動翻譯。支援串流的介面可開啟串流輸出：已完成的字幕先顯示，不必等整集完成；跳到尚未譯完的位置仍需等待。",
    "2. Return to the episode's subtitle menu, choose source and target languages, then start translation. With a streaming-capable API, completed cues appear before the whole episode is ready. Seeking beyond translated cues still requires waiting.",
    "2. 字幕メニューに戻り、元の字幕と翻訳先言語を選んで開始します。対応 API でストリーミングを有効にすると、完了した字幕から表示されます。未翻訳の位置へ移動した場合は待つ必要があります。"
  ],
  [
    "3. 可以暂停、继续或在失败后重试未完成部分。先从每批 15 条、并发 1、超时 60 秒试起，再逐步增加；频繁超时或限流时降低批量和并发。缓存仍在且设置匹配时可复用进度，清缓存或更换配置后可能需要重新翻译。",
    "3. 可以暫停、繼續或在失敗後重試未完成部分。先從每批 15 條、並行 1、逾時 60 秒試起，再逐步增加；頻繁逾時或限流時降低批量和並行數。快取仍在且設定匹配時可重用進度，清除快取或更換設定後可能需要重新翻譯。",
    "3. Pause, resume or retry unfinished work after a failure. Start with 15 cues per batch, concurrency 1 and a 60-second timeout, then increase gradually. Reduce batch size and concurrency on timeouts or rate limits. Progress can be reused when cache and settings match; clearing cache or changing configuration may require translating again.",
    "3. 一時停止・再開・失敗箇所の再試行ができます。まず 15 行／バッチ・同時実行 1・タイムアウト 60 秒で試し、徐々に増やしてください。タイムアウトや制限が多い場合は減らします。キャッシュと設定が一致すれば進捗を再利用できますが、削除や設定変更で再翻訳が必要になる場合があります。"
  ],
  [
    "翻译会将字幕发送到你选择的服务，可能产生费用。找不到外部字幕不会自动触发付费机翻；界面语言也不会改变翻译目标语言。",
    "翻譯會將字幕傳送至你選擇的服務，可能產生費用。找不到外部字幕不會自動觸發付費機器翻譯；介面語言也不會改變翻譯目標語言。",
    "Translation sends subtitle text to your chosen service and may incur charges. An empty external search does not automatically start paid translation. UI language and translation target are separate settings.",
    "翻訳時は選択したサービスに字幕が送信され、料金が発生する場合があります。外部字幕が見つからなくても有料翻訳は自動開始しません。表示言語と翻訳先言語は別設定です。"
  ],
  [
    "作品资料与校对导出",
    "作品資料與校對匯出",
    "Work details and proofreading exports",
    "作品情報と校正用エクスポート"
  ],
  [
    "翻译前可从播放器菜单打开「作品资料」，核对识别的作品，查询并确认资料，整理角色名和术语后保存。资料用于辅助模型理解，不保证消除误译；AI 整理需要支持分析的接口，不能用 DeepL 代替。",
    "翻譯前可從播放器選單開啟「作品資料」，核對辨識的作品，查詢並確認資料，整理角色名和術語後儲存。資料用於輔助模型理解，不保證消除誤譯；AI 整理需要支援分析的介面，不能用 DeepL 代替。",
    "Before translating, open Work details from the player, verify the title, look up and confirm information, then save character names and terminology. Context can help the model but cannot guarantee accuracy. AI organization requires an analysis-capable API, not DeepL.",
    "翻訳前にプレーヤーから「作品情報」を開き、作品を確認し、情報を検索・確認して登場人物名や用語を保存できます。文脈は翻訳を補助しますが、誤訳を完全には防げません。AI 整理には分析対応 API が必要で、DeepL は使えません。"
  ],
  [
    "从字幕菜单的导出功能保存字幕或校对 CSV，可对照原文、人工字幕和机翻结果。官方没有中文字幕时，不影响外部字幕搜索或机翻，也不必先准备中文参考。",
    "從字幕選單的匯出功能儲存字幕或校對 CSV，可對照原文、人工字幕和機器翻譯結果。官方沒有中文字幕時，不影響外部字幕搜尋或機器翻譯，也不必先準備中文參考。",
    "Export subtitles or proofreading CSV files from the subtitle menu to compare original text, human subtitles and machine output. Official Chinese subtitles are not required for external search or machine translation.",
    "字幕メニューから字幕や校正用 CSV をエクスポートし、原文・人手の字幕・機械翻訳を比較できます。公式の中国語字幕がなくても、外部字幕の検索や機械翻訳は利用できます。"
  ],
  [
    "遇到问题时",
    "遇到問題時",
    "When something goes wrong",
    "困ったとき"
  ],
  [
    "搜不到：核对作品和季，换语言名称或字幕源。下载失败：重新获取详情、换候选，或下载后本地导入。下一集没跟随：检查是否勾选跟随并加载过，以及该发布版本是否有对应集。",
    "搜尋不到：核對作品和季，換語言名稱或字幕源。下載失敗：重新取得詳情、換候選，或下載後本機匯入。下一集未跟隨：檢查是否勾選跟隨並載入過，以及該發布版本是否有對應集。",
    "No results? Check the title and season, then try another language name or provider. Download failed? Refresh details, try another candidate or import a downloaded file. No next-episode track? Check that follow was enabled before loading and that the release contains that episode.",
    "検索結果がない場合は作品・シーズンを確認し、別言語名や別サービスを試します。ダウンロード失敗時は詳細を再取得するか、別候補またはローカル読み込みを試します。次話に追従しない場合は、追従を有効にして読み込んだか、その版に該当話があるかを確認してください。"
  ],
  [
    "更新时将完整安装包覆盖到原加载目录，再重新加载扩展并刷新播放页。不要删除扩展，以免丢失本地设置；更新后仍有后台加载错误时，完全退出浏览器再重开。",
    "更新時將完整安裝包覆蓋至原載入目錄，再重新載入擴充功能並重新整理播放頁。不要刪除擴充功能，以免遺失本機設定；更新後仍有背景載入錯誤時，完全退出瀏覽器再重開。",
    "To update, replace the files in the original loaded folder with the complete package, reload the extension and refresh the episode. Do not remove the extension if you want to keep local settings. If background loading still fails after updating, fully exit and reopen the browser.",
    "更新時は元の読み込みフォルダーに完全なパッケージを上書きし、拡張機能と再生ページを再読み込みします。設定を保持するには拡張機能を削除しないでください。更新後もバックグラウンドの読み込みに失敗する場合は、ブラウザーを完全に終了して起動し直してください。"
  ]
];
  i18n.add(Object.fromEntries(rows.map(([source, traditional, english, japanese]) =>
    [source, { 'zh-Hans': source, 'zh-Hant': traditional, en: english, ja: japanese }])));
  const repaint = () => i18n.localize(document.body);
  i18n.ready.then(repaint);
  i18n.watch(repaint);
})();

