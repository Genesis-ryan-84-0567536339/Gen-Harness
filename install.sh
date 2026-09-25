#!/bin/sh
# Gen-Harness — bootstrap một lệnh (Linux/macOS).
#
#   curl -fsSL https://github.com/Genesis-ryan-84-0567536339/Gen-Harness/releases/latest/download/install.sh | sh
#
# Việc duy nhất của tệp này: tải đúng binary genh cho máy, kiểm SHA-256,
# thêm vào PATH, rồi giao lại cho `genh install` (xem
# docs/handoff/05-installer.md). Không giả định có gì ngoài `sh` + mạng +
# curl HOẶC wget — không cần Docker, git, Python, Node… có sẵn.
set -eu

REPO="Genesis-ryan-84-0567536339/Gen-Harness"
RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"
INSTALL_ROOT="${GEN_HARNESS_HOME:-$HOME/.gen-harness}"
BIN_DIR="${INSTALL_ROOT}/bin"

log() { printf '%s\n' "$*" >&2; }
die() {
	log "genh: $*"
	exit 1
}

# fetch <url> <đích>: dùng curl nếu có, không thì wget.
fetch() {
	url="$1"
	dest="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$dest" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$dest" "$url"
	else
		die "cần curl hoặc wget để tải genh, máy này không có cái nào."
	fi
}

detect_os() {
	case "$(uname -s)" in
	Linux) echo "linux" ;;
	Darwin) echo "darwin" ;;
	*) die "hệ điều hành $(uname -s) chưa được hỗ trợ (chỉ Linux/macOS — Windows dùng install.ps1)." ;;
	esac
}

detect_arch() {
	case "$(uname -m)" in
	x86_64 | amd64) echo "amd64" ;;
	arm64 | aarch64) echo "arm64" ;;
	*) die "kiến trúc $(uname -m) chưa được hỗ trợ." ;;
	esac
}

sha256_of() {
	file="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$file" | awk '{print $1}'
	else
		die "cần sha256sum hoặc shasum để kiểm chữ ký binary, máy này không có cái nào."
	fi
}

verify_checksum() {
	bin_file="$1"
	bin_name="$2"
	checksums_file="$3"

	# So khớp theo tên tệp cuối cùng (basename), vì checksums.txt có thể ghi
	# "genh-linux-amd64" hoặc "./genh-linux-amd64" tuỳ công cụ tạo ra nó.
	want=$(awk -v n="$bin_name" '{ f=$2; sub(/^\.\//, "", f); if (f == n) print $1 }' "$checksums_file")
	if [ -z "$want" ]; then
		die "không tìm thấy $bin_name trong checksums.txt của bản phát hành — dừng, không chạy."
	fi

	got=$(sha256_of "$bin_file")
	if [ "$got" != "$want" ]; then
		die "SHA-256 của $bin_name không khớp checksums.txt (muốn $want, được $got) — dừng, không chạy."
	fi
}

# add_to_path <dòng export>: ghi vào rc file của shell hiện có (idempotent —
# không thêm trùng), không cần quyền admin vì chỉ ghi vào $HOME.
add_to_path() {
	export_line="export PATH=\"${BIN_DIR}:\$PATH\""
	rc_file="$HOME/.profile"
	case "${SHELL:-}" in
	*/zsh) rc_file="$HOME/.zshrc" ;;
	*/bash) rc_file="$HOME/.bashrc" ;;
	esac

	if [ -f "$rc_file" ] && grep -qF "$BIN_DIR" "$rc_file" 2>/dev/null; then
		return 0
	fi
	printf '\n# Gen-Harness (genh)\n%s\n' "$export_line" >>"$rc_file" 2>/dev/null ||
		log "genh: không tự thêm PATH được vào $rc_file — tự thêm: $export_line"
}

main() {
	os=$(detect_os)
	arch=$(detect_arch)
	asset="genh-${os}-${arch}"

	log "genh: đang tải ${asset} từ bản phát hành mới nhất…"
	mkdir -p "$BIN_DIR"
	tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/genh-install.XXXXXX")
	trap 'rm -rf "$tmp_dir"' EXIT

	fetch "${RELEASE_BASE}/${asset}" "${tmp_dir}/${asset}"
	fetch "${RELEASE_BASE}/checksums.txt" "${tmp_dir}/checksums.txt"

	verify_checksum "${tmp_dir}/${asset}" "$asset" "${tmp_dir}/checksums.txt"

	chmod +x "${tmp_dir}/${asset}"
	mv "${tmp_dir}/${asset}" "${BIN_DIR}/genh"

	add_to_path
	PATH="${BIN_DIR}:$PATH"
	export PATH

	log "genh: đã cài vào ${BIN_DIR}/genh — mở phiên shell mới để PATH có hiệu lực lâu dài."
	exec "${BIN_DIR}/genh" install
}

main "$@"
