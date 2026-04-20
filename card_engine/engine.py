"""
Motor de geração da carteira (frente/costa + PDF).
Templates: membro_frente.png, membro_costa.png (595×375); o render interno pode usar _RENDER_SCALE>1.
Ajuste as coordenadas em LAYOUT_* se o texto não coincidir com as caixas do design.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

_ENGINE_DIR = Path(__file__).resolve().parent
_FONT_DIR = _ENGINE_DIR / "fonts"

from PIL import Image, ImageDraw, ImageFont

# --- Coordenadas em pixels (canvas lógico 595×375) — calibradas para os templates AD ---
_LINHA = 18  # “uma linha” em Y
_SPACE = 12  # “um espaço” em X (largura aproximada de carácter)
# Render interno em alta resolução (texto e PDF mais nítidos); DPI do PDF escala na mesma proporção.
_RENDER_SCALE = 2
_PDF_BASE_DPI = 150.0  # referência com canvas 1×; com _RENDER_SCALE=2 usa o dobro de DPI para manter o tamanho físico no PDF

_LIM_NOME_VISUAL = 25  # máximo de caracteres mostrados no nome (inclui reticências se truncar)

_FRENTE_DESCER = 4 * _LINHA  # ajuste global frente (foto + textos)
_COSTA_SUBIR = 2 * _LINHA  # ajuste global verso


def _box_dy(box: tuple[int, int, int, int], dy: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    return (x1, y1 + dy, x2, y2 + dy)


def _box_dx(box: tuple[int, int, int, int], dx: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    return (x1 + dx, y1, x2 + dx, y2)


def _scale_box(box: tuple[int, int, int, int], s: int) -> tuple[int, int, int, int]:
    return tuple(int(v * s) for v in box)


# Base (antes dos deslocamentos globais); depois aplicam-se _FRENTE_DESCER / _COSTA_SUBIR e micro-ajustes.
_BASE_FRENTE = {
    "foto_box": (26, 86, 156, 259),
    "nome": (168, 98, 575, 142),
    "cargo": (168, 158, 318, 188),
    "expedicao": (328, 158, 565, 188),
    "nasc": (168, 208, 288, 248),
    "batismo": (298, 208, 418, 248),
    "civil": (428, 208, 565, 248),
}

_BASE_COSTA = {
    "cpf": (32, 178, 198, 218),
    "nacionalidade": (208, 178, 388, 218),
    "cod": (398, 178, 568, 218),
    "qr": (478, 248, 575, 355),
}


def _build_layout_frente() -> dict[str, tuple[int, int, int, int]]:
    d = _FRENTE_DESCER
    out = {k: _box_dy(v, d) for k, v in _BASE_FRENTE.items()}
    # nome: +1 linha (pedido anterior) −½ linha + 1 espaço à direita
    out["nome"] = _box_dy(out["nome"], _LINHA - (_LINHA // 2))
    out["nome"] = _box_dx(out["nome"], _SPACE)
    # estado civil: “voltar” = à esquerda 3 espaços
    out["civil"] = _box_dx(out["civil"], -3 * _SPACE)
    # cargo: avançar 2 espaços (à direita)
    out["cargo"] = _box_dx(out["cargo"], 2 * _SPACE)
    # data de batismo: voltar 1 espaço (net: −2 + 1 avanço em relação à base)
    out["batismo"] = _box_dx(out["batismo"], -1 * _SPACE)
    # Expedição: voltar 2 espaços (à esquerda)
    out["expedicao"] = _box_dx(out["expedicao"], -2 * _SPACE)
    # Cargo e Expedição: subir ½ “espaço” (em Y)
    _half_sp = _SPACE // 2
    out["cargo"] = _box_dy(out["cargo"], -_half_sp)
    out["expedicao"] = _box_dy(out["expedicao"], -_half_sp)
    # Se invadir o cargo, encurta o cargo até deixar 2 px de folga
    cg = out["cargo"]
    ex = out["expedicao"]
    if ex[0] < cg[2]:
        out["cargo"] = (cg[0], cg[1], min(cg[2], ex[0] - 2), cg[3])
    return out


def _build_layout_costa() -> dict[str, tuple[int, int, int, int]]:
    u = _COSTA_SUBIR
    out = {k: (b[0], b[1] - u, b[2], b[3] - u) for k, b in _BASE_COSTA.items()}
    # CPF: avançar 2 espaços (à direita; net −1 em relação ao ajuste anterior)
    out["cpf"] = _box_dx(out["cpf"], 2 * _SPACE)
    # Cod. membro: voltar 4 espaços (à esquerda)
    out["cod"] = _box_dx(out["cod"], -4 * _SPACE)
    # Encurtar nacionalidade se o cod. tiver vindo para a esquerda e invadir a caixa do meio
    nac = out["nacionalidade"]
    cd = out["cod"]
    if cd[0] < nac[2]:
        # Encurta pela direita até não invadir o cod. (folga de 2 px)
        out["nacionalidade"] = (nac[0], nac[1], min(nac[2], cd[0] - 2), nac[3])
    return out


LAYOUT_FRENTE = _build_layout_frente()
LAYOUT_COSTA = _build_layout_costa()


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Poppins (embutida em `card_engine/fonts/`) com fallback DejaVu / Arial."""
    if bold:
        poppins_candidates = [
            _FONT_DIR / "Poppins-Bold.ttf",
            _FONT_DIR / "Poppins-SemiBold.ttf",
        ]
    else:
        # Texto “normal” ainda com peso alto (Poppins mais presente na carteira)
        poppins_candidates = [
            _FONT_DIR / "Poppins-SemiBold.ttf",
            _FONT_DIR / "Poppins-Medium.ttf",
        ]

    windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
    if windir:
        wf = Path(windir) / "Fonts"
        if bold:
            poppins_candidates.extend(
                (wf / "Poppins-Bold.ttf", wf / "poppins-bold.ttf", wf / "Poppins-SemiBold.ttf")
            )
        else:
            poppins_candidates.extend(
                (
                    wf / "Poppins-SemiBold.ttf",
                    wf / "poppins-semibold.ttf",
                    wf / "Poppins-Medium.ttf",
                    wf / "poppins-medium.ttf",
                )
            )

    for p in poppins_candidates:
        if p.is_file():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                continue

    names = ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf") if bold else ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf")
    dirs = (
        "/usr/share/fonts/dejavu/",
        "/usr/share/fonts/TTF/",
        "/usr/share/fonts/truetype/dejavu/",
        str(Path(windir) / "Fonts") if windir else "",
        "C:\\Windows\\Fonts\\",
    )
    for d in dirs:
        if not d:
            continue
        for n in names:
            p = Path(d) / n
            if p.exists():
                try:
                    return ImageFont.truetype(str(p), size)
                except OSError:
                    continue
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _fmt_data_br(iso: str | None) -> str:
    if not iso:
        return "—"
    s = str(iso).strip()
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        y, m, d = s[:10].split("-")
        return f"{d}/{m}/{y}"
    return s


def _fmt_cpf(d: str | None) -> str:
    if not d:
        return "—"
    c = "".join(x for x in str(d) if x.isdigit())
    if len(c) != 11:
        return str(d)
    return f"{c[:3]}.{c[3:6]}.{c[6:9]}-{c[9:]}"


def _draw_text_in_box(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int] = (255, 255, 255),
    anchor: str = "mm",
) -> None:
    x1, y1, x2, y2 = box
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    draw.text((cx, cy), text, font=font, fill=fill, anchor=anchor)


def _draw_text_in_box_tl(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int] = (255, 255, 255),
    inset: int = 4,
) -> None:
    x1, y1, x2, y2 = box
    draw.text((x1 + inset, y1 + inset), text, font=font, fill=fill, anchor="lt")


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> int:
    if not text:
        return 0
    b = draw.textbbox((0, 0), text, font=font)
    return b[2] - b[0]


def _draw_text_in_box_mm_pair(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    left: str,
    font_left: ImageFont.ImageFont,
    right: str,
    font_right: ImageFont.ImageFont,
    fill: tuple[int, int, int] = (255, 255, 255),
) -> None:
    """Uma linha centrada na caixa: `left` + `right` com fontes distintas (ex.: rótulo + data)."""
    x1, y1, x2, y2 = box
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    w_l = _text_width(draw, left, font_left)
    w_r = _text_width(draw, right, font_right)
    start_x = int(cx - (w_l + w_r) / 2)
    draw.text((start_x, cy), left, font=font_left, fill=fill, anchor="lm")
    draw.text((start_x + w_l, cy), right, font=font_right, fill=fill, anchor="lm")


def _paste_foto_cover(base: Image.Image, foto: Image.Image, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    if w < 2 or h < 2:
        return
    img = foto.convert("RGBA")
    scale = max(w / img.width, h / img.height)
    nw = int(img.width * scale)
    nh = int(img.height * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    crop = img.crop((left, top, left + w, top + h))
    if crop.mode == "RGBA":
        base.paste(crop, (x1, y1), crop)
    else:
        base.paste(crop, (x1, y1))


def render_frente(
    tpl_path: Path,
    foto_bytes: bytes | None,
    dados: dict[str, Any],
) -> Image.Image:
    s = _RENDER_SCALE
    tpl = Image.open(tpl_path).convert("RGBA")
    base = tpl.resize((595 * s, 375 * s), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(base)
    L = {k: _scale_box(v, s) for k, v in LAYOUT_FRENTE.items()}

    if foto_bytes:
        foto = Image.open(io.BytesIO(foto_bytes))
        _paste_foto_cover(base, foto, L["foto_box"])

    nome_raw = str(dados.get("nome_completo") or "").strip() or "—"
    # Pedido: se o nome tiver 11 caracteres, usar corpo 12 pt (senão 17 pt)
    fnome = _font(int((12 if len(nome_raw) == 11 else 17) * s), bold=True)
    fmed = _font(int(13 * s), bold=True)
    fmed_label = _font(int(13 * s), bold=False)  # “Expedição:” sem negrito; só a data em negrito
    fsmall = _font(int(12 * s), bold=True)
    tl_inset = max(2, int(4 * s))

    nome = nome_raw
    if len(nome) > _LIM_NOME_VISUAL:
        nome = nome[: max(1, _LIM_NOME_VISUAL - 1)] + "…"
    _draw_text_in_box_tl(draw, L["nome"], nome, fnome, inset=tl_inset)

    cargo = str(dados.get("cargo") or "—").strip()
    _draw_text_in_box(draw, L["cargo"], cargo, fmed)

    exp = str(dados.get("data_expedicao") or "").strip()
    if exp:
        _draw_text_in_box_mm_pair(draw, L["expedicao"], "Expedição: ", fmed_label, exp, fmed)
    else:
        _draw_text_in_box(draw, L["expedicao"], "—", fmed_label)

    _draw_text_in_box(draw, L["nasc"], _fmt_data_br(dados.get("data_nasc")), fsmall)
    _draw_text_in_box(draw, L["batismo"], _fmt_data_br(dados.get("data_batismo")), fsmall)
    _draw_text_in_box(draw, L["civil"], str(dados.get("estado_civil") or "—"), fsmall)

    return base.convert("RGB")


def render_costa(
    tpl_path: Path,
    dados: dict[str, Any],
    qr_payload: str,
) -> Image.Image:
    s = _RENDER_SCALE
    tpl = Image.open(tpl_path).convert("RGBA")
    base = tpl.resize((595 * s, 375 * s), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(base)
    L = {k: _scale_box(v, s) for k, v in LAYOUT_COSTA.items()}
    fmed = _font(int(13 * s), bold=True)

    _draw_text_in_box(draw, L["cpf"], _fmt_cpf(dados.get("cpf")), fmed)
    _draw_text_in_box(draw, L["nacionalidade"], str(dados.get("nacionalidade") or "—"), fmed)
    cod = dados.get("cod_membro")
    _draw_text_in_box(draw, L["cod"], str(cod) if cod is not None else "—", fmed)

    try:
        import qrcode

        qr_mod = max(2, int(3 * s))
        qr_border = max(1, s // 2)
        qr = qrcode.QRCode(version=None, box_size=qr_mod, border=qr_border)
        qr.add_data(qr_payload[:800])
        qr.make(fit=True)
        qimg = qr.make_image(fill_color="#1a1a2e", back_color="white").convert("RGBA")
        x1, y1, x2, y2 = L["qr"]
        qimg = qimg.resize((x2 - x1, y2 - y1), Image.Resampling.LANCZOS)
        base.paste(qimg, (x1, y1), qimg)
    except Exception:
        pass

    return base.convert("RGB")


def gerar_carteira(payload: dict[str, Any]) -> tuple[bytes, bytes, bytes]:
    """
    payload keys:
      paths: membro_frente, membro_costa (str paths)
      foto_bytes: opcional bytes da foto
      membro: dict com campos DB
      protocolo: str para QR
      public_base_url: str opcional (sem barra final)
    """
    paths = payload.get("paths") or {}
    mf = Path(str(paths.get("membro_frente", "membro_frente.png")))
    mc = Path(str(paths.get("membro_costa", "membro_costa.png")))
    if not mf.is_file() or not mc.is_file():
        raise FileNotFoundError(f"Templates em falta: {mf} / {mc}")

    membro = payload.get("membro") or {}
    foto_bytes: bytes | None = None
    fp = payload.get("foto_path")
    if fp and Path(str(fp)).is_file():
        foto_bytes = Path(str(fp)).read_bytes()

    protocolo = str(payload.get("protocolo") or "")
    base_url = str(payload.get("public_base_url") or "").rstrip("/")
    qr_payload = (
        f"{base_url}/membro-qr?protocolo={quote(protocolo, safe='')}"
        if base_url and protocolo
        else protocolo or "—"
    )

    front = render_frente(mf, foto_bytes, membro)
    back = render_costa(mc, membro, qr_payload)

    buf_f = io.BytesIO()
    buf_b = io.BytesIO()
    front.save(buf_f, format="PNG", optimize=True)
    back.save(buf_b, format="PNG", optimize=True)

    buf_pdf = io.BytesIO()
    pdf_dpi = _PDF_BASE_DPI * _RENDER_SCALE
    front.save(
        buf_pdf,
        format="PDF",
        resolution=pdf_dpi,
        save_all=True,
        append_images=[back],
    )

    return buf_f.getvalue(), buf_b.getvalue(), buf_pdf.getvalue()


def main_cli() -> None:
    import sys

    if len(sys.argv) < 2:
        print("Uso: python engine.py <ficheiro.json>", file=sys.stderr)
        sys.exit(2)
    p = Path(sys.argv[1])
    data = json.loads(p.read_text(encoding="utf-8"))
    out_f = Path(data["out_frente_png"])
    out_b = Path(data["out_costa_png"])
    out_pdf = Path(data["out_pdf"])
    for d in (out_f.parent, out_b.parent, out_pdf.parent):
        d.mkdir(parents=True, exist_ok=True)

    png_f, png_b, pdf = gerar_carteira(data)
    out_f.write_bytes(png_f)
    out_b.write_bytes(png_b)
    out_pdf.write_bytes(pdf)
    print(json.dumps({"ok": True, "out_frente_png": str(out_f), "out_costa_png": str(out_b), "out_pdf": str(out_pdf)}))


if __name__ == "__main__":
    main_cli()

