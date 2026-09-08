# Unicode classification fixture: some glyphs are in Romulus and some require fallback.
latin = "français é è à ç œ"
greek = "α β Δ λ"
cyrillic = "Ж Д Я"
japanese = "日本語のテスト / こんにちは世界"
emoji = "😀 🚀 ✅ ⚠️ 🔒 🧪"
maths = "≠ ≤ ≥ ≈ ∞ ∑ √"
technical = "→ ← ↑ ↓ ⇒ ⇥ ¶ ¤ » ␉ ␍ ␊"

# Real controls remain in the source; the codec represents line structure separately.
def tabs_and_lines():
	return "tab-indented", "line one\r\nline two\n"
