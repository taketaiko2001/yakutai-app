# スマホで「PCで読む」ページを開くための QR コードを作る
#   python pc/make_qr.py
# PC のサーバー（pc/server.js）が起動のたびにこれを動かし、できた QR コードを PC の画面に出す。アプリを更新したときも作り直す
# アドレスに版（?v=…）を付けるので、読み込むと必ず新しい画面が開く（開いたままの古いタブに切り替わらない）
# 保存先: yakutai-app フォルダの先頭（0_スマホで開くQRコード.png）
import os, re, socket, datetime
import qrcode
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
PORT = 8787


def lan_ip():
    # 院内の Wi-Fi でのこの PC のアドレス（外には何も送らない。経路を調べるだけ）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.168.1.1", 9))
        ip = s.getsockname()[0]
        s.close()
        if re.match(r"^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))", ip):
            return ip
    except OSError:
        pass
    return "192.168.1.12"


def font(size, bold=False):
    for f in (["BIZ-UDGothicB.ttc", "meiryob.ttc"] if bold else ["BIZ-UDGothicR.ttc", "meiryo.ttc"]):
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", f)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def main():
    ver = re.search(r'APP_VERSION = "([^"]+)"', open(os.path.join(APP, "docs", "js", "app.js"), encoding="utf-8").read()).group(1)
    url = f"http://{lan_ip()}:{PORT}/?v={ver}"
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=14, border=3)
    q.add_data(url)
    q.make(fit=True)
    code = q.make_image(fill_color="black", back_color="white").convert("RGB")
    W = max(code.width, 620)
    img = Image.new("RGB", (W, code.height + 250), "white")
    img.paste(code, ((W - code.width) // 2, 110))
    d = ImageDraw.Draw(img)
    now = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")
    lines = [("薬袋プリント（PCで読む）", font(40, True), 22), ("スマホのカメラで読み取って開いてください", font(26), 72)]
    for text, f, y in lines:
        d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill="black")
    y = 110 + code.height + 14
    for text, f in [(f"版 {ver}（{now} 作成）", font(28, True)), (url, font(22)),
                    ("PCの黒い画面（薬袋プリント）は閉じないでください", font(22))]:
        d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill="black")
        y += 42
    path = os.path.join(APP, "0_スマホで開くQRコード.png")
    img.save(path)
    print("保存しました:", path)
    print("アドレス:", url)


if __name__ == "__main__":
    main()
