// Pythonが個人設定から渡す検証済みの配色を、CSSと本文の描画より先に適用する。
(() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const root = document.documentElement;
  const theme = params.get("theme");
  const palette = params.get("palette");
  if (["light", "dark"].includes(theme)) root.dataset.theme = theme;
  if (["default", "blue", "blue_white"].includes(palette)) {
    root.dataset.colorPalette = palette;
  }
  root.style.colorScheme = root.dataset.theme;
})();
