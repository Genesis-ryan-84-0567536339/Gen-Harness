"""Băm mật khẩu/PIN (argon2id), token ngẫu nhiên, mã hoá phong bì AES-256-GCM cho bí mật."""

import base64
import hashlib
import hmac
import os
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from gh.config import get_settings

_hasher = PasswordHasher()
_dev_master_key: bytes | None = None


def hash_secret(value: str) -> str:
    return _hasher.hash(value)


def verify_secret(stored_hash: str | None, value: str) -> bool:
    if not stored_hash:
        return False
    try:
        return _hasher.verify(stored_hash, value)
    except (VerificationError, InvalidHashError):
        return False


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_digest(token: str) -> bytes:
    """Băm token phiên/CSRF/setup để lưu DB (không lưu token gốc)."""
    return hashlib.sha256(token.encode()).digest()


def master_key() -> bytes:
    global _dev_master_key
    s = get_settings()
    raw = s.master_key
    if s.master_key_file:
        with open(s.master_key_file, encoding="utf-8") as f:
            raw = f.read().strip()
    if raw:
        key = base64.b64decode(raw)
        if len(key) != 32:
            raise ValueError("GH_MASTER_KEY phải là 32 byte base64")
        return key
    if s.is_production:
        raise RuntimeError("Thiếu GH_MASTER_KEY ở production")
    if _dev_master_key is None:
        _dev_master_key = os.urandom(32)
    return _dev_master_key


def encrypt(plaintext: bytes, associated: bytes = b"") -> bytes:
    """Mã hoá phong bì: khoá dữ liệu ngẫu nhiên mã hoá nội dung, khoá master mã hoá khoá dữ liệu.

    Định dạng: b"GH1" | nonce_k(12) | enc_dek(48) | nonce_d(12) | ciphertext
    """
    dek = AESGCM.generate_key(bit_length=256)
    nonce_k, nonce_d = os.urandom(12), os.urandom(12)
    enc_dek = AESGCM(master_key()).encrypt(nonce_k, dek, b"dek")
    ct = AESGCM(dek).encrypt(nonce_d, plaintext, associated)
    return b"GH1" + nonce_k + enc_dek + nonce_d + ct


def decrypt(blob: bytes, associated: bytes = b"") -> bytes:
    if blob[:3] != b"GH1":
        raise ValueError("Định dạng bí mật không hợp lệ")
    nonce_k, enc_dek, nonce_d, ct = blob[3:15], blob[15:63], blob[63:75], blob[75:]
    dek = AESGCM(master_key()).decrypt(nonce_k, enc_dek, b"dek")
    return AESGCM(dek).decrypt(nonce_d, ct, associated)


def hmac_sign(message: bytes) -> bytes:
    key = hashlib.sha256(master_key() + b"permit").digest()
    return hmac.new(key, message, hashlib.sha256).digest()


def hmac_verify(message: bytes, signature: bytes) -> bool:
    return hmac.compare_digest(hmac_sign(message), signature)
