"""F123 — lớp che dữ liệu trước khi gửi model phải che mã OTP/mã xác minh, mật khẩu trong nội dung thư và
tham số token/code/key trong URL (QD-16: mọi nội dung qua `mask_for_model`). Kho mẫu thư vi/en."""

import pytest

from gh.chassis.masking import MASK, mask_error, mask_for_model

# (nội dung thư, chuỗi bí mật phải biến mất)
THU_CO_BI_MAT = [
    ("Mã xác minh của bạn là 482913", "482913"),
    ("Mã xác minh của bạn là: 482913. Không chia sẻ mã này.", "482913"),
    ("Mã OTP: 7391", "7391"),
    ("OTP 73915842 có hiệu lực 5 phút", "73915842"),
    ("Mã xác thực 123456 dùng một lần", "123456"),
    ("Mã bảo mật của anh/chị là 5530", "5530"),
    ("Ma xac minh cua ban la 482913", "482913"),
    ("Your verification code is 482913", "482913"),
    ("Your one-time code is: 482913", "482913"),
    ("Use code 482913 to sign in", "482913"),
    ("Security code: 98765", "98765"),
    ("Your OTP is 4821", "4821"),
    ("482913 là mã xác minh của bạn", "482913"),
    ("G-482913 is your Google verification code.", "482913"),
    ("482913 is your verification code", "482913"),
    ("Mã xác minh: 482 913", "482 913"),
    ("Mật khẩu tạm: Abc@12345xyz", "Abc@12345xyz"),
    ("Mật khẩu mới của bạn là Abc@12345xyz.", "Abc@12345xyz"),
    ("Mật khẩu: Zebra-Lamp-Cloud", "Zebra-Lamp-Cloud"),
    ("Tài khoản mới: sếp. mật khẩu: 12345678", "12345678"),
    ("password: hunter2hunter2", "hunter2hunter2"),
    ("Your temporary password is Xk9#mP2qLw", "Xk9#mP2qLw"),
    ("Password = correcthorse", "correcthorse"),
    ("Please reset: https://app.example.com/reset?token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA&lang=vi",
     "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"),
    ("Link: https://x.example.com/verify?email=a%40b.c&code=583920", "583920"),
    ("https://x.example.com/cb?access_token=abcDEF123456&state=1", "abcDEF123456"),
    ("https://x.example.com/u?API_KEY=k3y-v4lue-0001", "k3y-v4lue-0001"),
    ("Mở https://x.example.com/reset-password/Qm9zc1NlY3JldFRva2VuMTIz để đặt lại", "Qm9zc1NlY3JldFRva2VuMTIz"),
]

# Thư thường: KHÔNG được bị che oan (nội dung còn đọc được để Gen tóm tắt/soạn trả lời)
THU_THUONG = [
    "Hẹn họp lúc 14:30 ngày 2026-10-20 về đơn hàng 1234.",
    "Please review the code in PR 4821 before Friday.",
    "Mật khẩu của bạn đã được đặt lại thành công.",
    "Your password is required to be at least 8 characters.",
    "Tổng cộng 4 mã giảm giá, trong đó 2 mã còn hạn.",
    "Mã đơn hàng ABC-1234 đã giao.",
    "Xem tại https://example.com/bao-cao?trang=2&lang=vi",
    "Code review hôm nay lúc 3 giờ chiều.",
]


@pytest.mark.parametrize(("mail", "secret"), THU_CO_BI_MAT)
def test_che_bi_mat_trong_thu(mail: str, secret: str) -> None:
    out = mask_for_model(mail)
    assert secret not in out, out
    assert MASK in out, out


@pytest.mark.parametrize("mail", THU_THUONG)
def test_thu_thuong_khong_bi_che_oan(mail: str) -> None:
    assert mask_for_model(mail) == mail


def test_giu_phan_con_lai_cua_thu() -> None:
    out = mask_for_model("Xin chào Sếp, mã xác minh của bạn là 482913. Cảm ơn!")
    assert out.startswith("Xin chào Sếp, mã xác minh của bạn là ")
    assert out.endswith(". Cảm ơn!")


def test_che_trong_cau_truc_long_nhau_va_loi() -> None:
    data = {"snippet": "Your verification code is 482913", "items": [{"body": "password: hunter2hunter2"}]}
    out = mask_for_model(data)
    assert "482913" not in str(out)
    assert "hunter2hunter2" not in str(out)
    assert "482913" not in mask_error("401: https://x.example.com/cb?code=482913")


def test_khong_pha_id_giu_theo_keep_keys() -> None:
    out = mask_for_model({"id": "18f3a9c2b7d4e601", "body": "OTP 4821"}, keep_keys=frozenset({"id"}))
    assert out["id"] == "18f3a9c2b7d4e601"
    assert "4821" not in out["body"]
