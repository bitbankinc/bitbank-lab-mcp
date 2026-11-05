---
paths:
  - "**/*.html"
---

# HTML 出力時の Tailwind CSS

- `cdn.tailwindcss.com`（Play CDN）は**使用禁止**。
- `<link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">` を使う。
- `bg-opacity-*`, `bg-[#xxx]`, `backdrop-*`, `ring-*` は非対応。`<style>` ブロックか `style` 属性で代替。
