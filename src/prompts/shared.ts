export const DISCLAIMER_MARKET = `---
⚠️ 免責事項：この分析は参考情報であり、解釈には誤差が含まれる場合があります。
板情報は秒単位で変動するため、実際のトレード前には最新状況を再確認してください。
投資判断はご自身の責任でお願いします。`;

export const DISCLAIMER_SHORT = `---
⚠️ 免責事項：この分析は参考情報です。投資判断はご自身の責任でお願いします。`;

export const VISUALIZER_MODE_ARG = {
	name: 'mode',
	description: '出力モード: "visualizer"（デフォルト）または "html"',
	required: false as const,
};

export const VISUALIZER_OUTPUT_BLOCK = `【出力】
- デフォルト: Visualizer（show_widget）でインライン可視化。レイアウト・配色は読みやすく整える。
- mode=html のときのみ: create_file → present_files（Tailwind ダークテーマ、最大幅800px。.claude/rules/html.md 準拠）
- ツール content / summary の数値・時刻・期間は推測せずそのまま表記する`;
