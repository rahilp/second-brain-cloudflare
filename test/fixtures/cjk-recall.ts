/**
 * Issue #326's downstream validation shape: 30 Japanese, 15 mixed CJK/ASCII,
 * 15 identifier queries. Each item's discriminating term appears in no other
 * item's content, so with Vectorize unavailable the keyword arm must rank `id`
 * first for `query`.
 *
 * Runs on real SQLite only. The D1 mock folds full-width case in JavaScript,
 * which SQLite does not, so it would certify retrieval that production cannot
 * perform.
 */
export interface CjkRecallItem { id: string; content: string; query: string }

export const CJK_RECALL_FIXTURE: CjkRecallItem[] = [
  // ── Japanese ────────────────────────────────────────────────────────────────
  { id: "jp-01", content: "認証方式をパスキーに変更した理由はフィッシング対策のため", query: "認証方式を変更した理由" },
  { id: "jp-02", content: "東京都庁は新宿にある", query: "東京都庁" },
  { id: "jp-03", content: "定例会議は水曜日の午後に移動した", query: "水曜日の会議" },
  { id: "jp-04", content: "来年度の予算は三月までに確定する", query: "予算 確定" },
  { id: "jp-05", content: "契約書の署名は来週に延期された", query: "契約書 署名" },
  { id: "jp-06", content: "歯医者の予約を金曜日に取った", query: "歯医者 予約" },
  { id: "jp-07", content: "引越しの荷造りを週末に始める", query: "引越し 荷造り" },
  { id: "jp-08", content: "母の誕生日は十月九日", query: "誕生日" },
  { id: "jp-09", content: "図書館で借りた本を返却する", query: "図書館 返却" },
  { id: "jp-10", content: "電車の定期券を更新した", query: "定期券" },
  { id: "jp-11", content: "自転車のタイヤを交換した", query: "自転車 タイヤ" },
  { id: "jp-12", content: "カレーの作り方を覚えた", query: "カレー 作り方" },
  { id: "jp-13", content: "箱根の温泉旅館に泊まった", query: "温泉旅館" },
  { id: "jp-14", content: "北海道旅行は八月に決めた", query: "北海道旅行" },
  { id: "jp-15", content: "写真の整理が終わった", query: "写真 整理" },
  { id: "jp-16", content: "ピアノの練習を毎朝続けている", query: "ピアノ 練習" },
  { id: "jp-17", content: "映画の感想をブログに書いた", query: "映画 感想" },
  { id: "jp-18", content: "英語の勉強を再開した", query: "英語 勉強" },
  { id: "jp-19", content: "明日の天気は雨の予報", query: "天気 予報" },
  { id: "jp-20", content: "財布をカフェに忘れた", query: "財布 忘れた" },
  { id: "jp-21", content: "洗濯機が壊れたので修理を頼んだ", query: "洗濯機 修理" },
  { id: "jp-22", content: "部屋の掃除を日曜日にする", query: "掃除 日曜日" },
  { id: "jp-23", content: "花火大会は七月の最終土曜日", query: "花火大会" },
  { id: "jp-24", content: "桜が満開になった", query: "桜" },
  { id: "jp-25", content: "夢の中で空を飛んだ", query: "夢" },
  { id: "jp-26", content: "猫が窓辺で寝ている", query: "猫" },
  { id: "jp-27", content: "犬の散歩は朝六時", query: "犬" },
  { id: "jp-28", content: "パスワードを九十日ごとに変える", query: "パスワード" },
  { id: "jp-29", content: "データベースのバックアップを毎晩取る", query: "データベース バックアップ" },
  { id: "jp-30", content: "サーバーの再起動は深夜に行う", query: "サーバー 再起動" },
  // ── Mixed CJK / ASCII ───────────────────────────────────────────────────────
  { id: "mx-01", content: "Cloudflare Workers のデプロイ手順をメモした", query: "Cloudflare デプロイ" },
  { id: "mx-02", content: "GitHub の PR レビューは金曜日まで", query: "GitHub レビュー" },
  { id: "mx-03", content: "Docker イメージのビルドが遅い", query: "Docker ビルド" },
  { id: "mx-04", content: "Slack の通知をミュートした", query: "Slack ミュート" },
  { id: "mx-05", content: "Notion にプロジェクト計画を書いた", query: "Notion 計画" },
  { id: "mx-06", content: "Python を 3.12 に上げた", query: "Python 3.12" },
  { id: "mx-07", content: "React のコンポーネント設計", query: "React コンポーネント" },
  { id: "mx-08", content: "AWS の請求額が増えた", query: "AWS 請求" },
  { id: "mx-09", content: "Figma でワイヤーフレームを作った", query: "Figma ワイヤーフレーム" },
  { id: "mx-10", content: "Kubernetes のクラスタ構成", query: "Kubernetes クラスタ" },
  { id: "mx-11", content: "TypeScript の型エラーを直した", query: "TypeScript 型エラー" },
  { id: "mx-12", content: "ｷｬﾘｱ相談を申し込んだ", query: "ｷｬﾘｱ" },
  { id: "mx-13", content: "Rust のコンパイル時間を短縮", query: "Rust コンパイル" },
  { id: "mx-14", content: "Vite でホットリロードが効く", query: "Vite ホットリロード" },
  { id: "mx-15", content: "監査2025 プロジェクトの締切", query: "監査2025" },
  // ── Identifiers (ASCII; must behave exactly as before) ─────────────────────
  { id: "id-01", content: "release v1.9 fixed the cursor bug", query: "v1.9" },
  { id: "id-02", content: "issue #149 tracks the tokenizer", query: "#149" },
  { id: "id-03", content: "docs live at https://example.com/docs/recall", query: "https://example.com/docs/recall" },
  { id: "id-04", content: "src/recall/search.ts owns fusion", query: "src/recall/search.ts" },
  { id: "id-05", content: "@cf/baai/bge-m3 is the multilingual model", query: "@cf/baai/bge-m3" },
  { id: "id-06", content: "spec deadline 2026-09-02", query: "2026-09-02" },
  { id: "id-07", content: "wrangler vars are key=value pairs", query: "key=value" },
  { id: "id-08", content: "run with --no-cache to rebuild", query: "--no-cache" },
  { id: "id-09", content: "contact user@example.com about billing", query: "user@example.com" },
  { id: "id-10", content: "PR-2048 merged on Monday", query: "PR-2048" },
  { id: "id-11", content: "the v2.3.2 tag was cut", query: "v2.3.2" },
  { id: "id-12", content: "ticket JIRA-771 is blocked", query: "JIRA-771" },
  { id: "id-13", content: "module foo.bar.baz exports helpers", query: "foo.bar.baz" },
  { id: "id-14", content: "port 8787 is wrangler dev", query: "8787" },
  { id: "id-15", content: "build hash a1b2c3d4", query: "a1b2c3d4" },
];

/** Seeded alongside the fixture; used by the full-width criterion test only. */
export const CJK_RECALL_EXTRA: { id: string; content: string }[] = [
  { id: "fw-ascii", content: "Terraform state lives in S3" },
  { id: "fw-wide", content: "Ｔｅｒｒａｆｏｒｍ の設定を全角で保存した" },
];
