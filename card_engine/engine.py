"""
Motor de geração da carteira (frente/costa + PDF).
Templates: membro_frente.png, membro_costa.png (595×375).
Ajuste as coordenadas em LAYOUT_* se o texto não coincidir com as caixas do design.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

# --- Coordenadas em pixels (canvas 595×375) — calibradas para os templates AD ---
# Referência de “linha” ≈ 18 px (altura útil de texto pequeno).
_LINHA = 18
_FRENTE_DESCER = 4 * _LINHA  # baixar toda a frente (foto + textos)
_COSTA_SUBIR = 2 * _LINHA  # subir verso

LAYOUT_FRENTE = {
    # caixa foto 3:4 (cobre com crop)
    "foto_box": (26, 86 + _FRENTE_DESCER, 156, 259 + _FRENTE_DESCER),
    "nome": (168, 98 + _FRENTE_DESCER, 575, 142 + _FRENTE_DESCER),
    "cargo": (168, 158 + _FRENTE_DESCER, 318, 188 + _FRENTE_DESCER),
    "expedicao": (328, 158 + _FRENTE_DESCER, 565, 188 + _FRENTE_DESCER),
    "nasc": (168, 208 + _FRENTE_DESCER, 288, 248 + _FRENTE_DESCER),
    "batismo": (298, 208 + _FRENTE_DESCER, 418, 248 + _FRENTE_DESCER),
    "civil": (428, 208 + _FRENTE_DESCER, 565, 248 + _FRENTE_DESCER),
}

LAYOUT_COSTA = {
    "cpf": (32, 178 - _COSTA_SUBIR, 198, 218 - _COSTA_SUBIR),
    "nacionalidade": (208, 178 - _COSTA_SUBIR, 388, 218 - _COSTA_SUBIR),
    "cod": (398, 178 - _COSTA_SUBIR, 568, 218 - _COSTA_SUBIR),
    "qr": (478, 248 - _COSTA_SUBIR, 575, 355 - _COSTA_SUBIR),
}


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf") if bold else ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf")
    dirs = (
        "/usr/share/fonts/dejavu/",
        "/usr/share/fonts/TTF/",
        "/usr/share/fonts/truetype/dejavu/",
        "C:\\Windows\\Fonts\\",
    )
    for d in dirs:
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
) -> None:
    x1, y1, x2, y2 = box
    draw.text((x1 + 4, y1 + 4), text, font=font, fill=fill, anchor="lt")


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
    base = Image.open(tpl_path).convert("RGBA")
    draw = ImageDraw.Draw(base)
    L = LAYOUT_FRENTE

    if foto_bytes:
        foto = Image.open(io.BytesIO(foto_bytes))
        _paste_foto_cover(base, foto, L["foto_box"])

    fnome = _font(17, bold=True)
    fmed = _font(13)
    fsmall = _font(11)

    nome = str(dados.get("nome_completo") or "").strip() or "—"
    if len(nome) > 44:
        nome = nome[:41] + "…"
    _draw_text_in_box_tl(draw, L["nome"], nome, fnome)

    cargo = str(dados.get("cargo") or "—").strip()
    _draw_text_in_box(draw, L["cargo"], cargo, fmed)

    exp = str(dados.get("data_expedicao") or "").strip()
    _draw_text_in_box(draw, L["expedicao"], f"Expedição: {exp}" if exp else "—", fmed)

    _draw_text_in_box(draw, L["nasc"], _fmt_data_br(dados.get("data_nasc")), fsmall)
    _draw_text_in_box(draw, L["batismo"], _fmt_data_br(dados.get("data_batismo")), fsmall)
    _draw_text_in_box(draw, L["civil"], str(dados.get("estado_civil") or "—"), fsmall)

    return base.convert("RGB")


def render_costa(
    tpl_path: Path,
    dados: dict[str, Any],
    qr_payload: str,
) -> Image.Image:
    base = Image.open(tpl_path).convert("RGBA")
    draw = ImageDraw.Draw(base)
    L = LAYOUT_COSTA
    fmed = _font(13)

    _draw_text_in_box(draw, L["cpf"], _fmt_cpf(dados.get("cpf")), fmed)
    _draw_text_in_box(draw, L["nacionalidade"], str(dados.get("nacionalidade") or "—"), fmed)
    cod = dados.get("cod_membro")
    _draw_text_in_box(draw, L["cod"], str(cod) if cod is not None else "—", fmed)

    try:
        import qrcode

        qr = qrcode.QRCode(version=None, box_size=3, border=1)
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
    qr_payload = f"{base_url}/?protocolo={protocolo}" if base_url and protocolo else protocolo or "—"

    front = render_frente(mf, foto_bytes, membro)
    back = render_costa(mc, membro, qr_payload)

    buf_f = io.BytesIO()
    buf_b = io.BytesIO()
    front.save(buf_f, format="PNG", optimize=True)
    back.save(buf_b, format="PNG", optimize=True)

    buf_pdf = io.BytesIO()
    front.save(
        buf_pdf,
        format="PDF",
        resolution=150.0,
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

