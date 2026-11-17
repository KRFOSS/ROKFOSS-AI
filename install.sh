#!/usr/bin/env bash
# ROKFOSS OpenCode installer.
#
# Installs a prebuilt `opencode` binary from this fork's GitHub releases:
#   curl -fsSL https://github.com/KRFOSS/ROKFOSS-AI/releases/latest/download/install.sh | bash
#
# The archives are built by .github/workflows/release-fork.yml and attached to a release as
# `opencode-<target>.tar.gz` (Linux) or `opencode-<target>.zip` (macOS, Windows), with a SHA256SUMS
# file next to them. Nothing here depends on npm or on the upstream opencode.ai endpoints.
set -euo pipefail

REPO="KRFOSS/ROKFOSS-AI"
APP="opencode"

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
GREEN='\033[0;32m'
NC='\033[0m'

usage() {
    cat <<EOF
ROKFOSS OpenCode Installer

Usage: install.sh [options]

Options:
    -h, --help              Display this help message
    -v, --version <tag>     Install a specific release (e.g. v2.3.0-krfoss.1)
    -b, --binary <path>     Install from a local binary instead of downloading
    -d, --dir <path>        Install directory (default: \$HOME/.opencode/bin)
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)
        --print-target      Print the detected release asset target and exit

Examples:
    curl -fsSL https://github.com/KRFOSS/ROKFOSS-AI/releases/latest/download/install.sh | bash
    curl -fsSL .../install.sh | bash -s -- --version v2.3.0-krfoss.1
    ./install.sh --binary /path/to/opencode
EOF
}

print_message() {
    local level=$1
    local message=$2
    local color
    case $level in
        info) color=$MUTED ;;
        success) color=$GREEN ;;
        warning) color=$ORANGE ;;
        error) color=$RED ;;
        *) color="" ;;
    esac
    echo -e "${color}${message}${NC}" 2>&1
}

error() {
    print_message error "Error: $1"
    exit 1
}

requested_version=${VERSION:-}
no_modify_path=false
print_target=false
binary_path=""
INSTALL_DIR="${OPENCODE_INSTALL_DIR:-$HOME/.opencode/bin}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="$2"
                shift 2
            else
                error "--version requires a version argument"
            fi
            ;;
        -b|--binary)
            if [[ -n "${2:-}" ]]; then
                binary_path="$2"
                shift 2
            else
                error "--binary requires a path argument"
            fi
            ;;
        -d|--dir)
            if [[ -n "${2:-}" ]]; then
                INSTALL_DIR="$2"
                shift 2
            else
                error "--dir requires a path argument"
            fi
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        --print-target)
            print_target=true
            shift
            ;;
        *)
            print_message warning "Warning: Unknown option '$1'"
            shift
            ;;
    esac
done

# os/arch/libc detection, matching the targets the release workflow builds.
detect_target() {
    local raw_os os arch combo is_musl needs_baseline
    raw_os=$(uname -s)
    case "$raw_os" in
        Darwin*) os="darwin" ;;
        Linux*) os="linux" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *) error "Unsupported OS: $raw_os" ;;
    esac

    arch=$(uname -m)
    if [[ "$arch" == "aarch64" ]]; then
        arch="arm64"
    fi
    if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
        arch="x64"
    fi

    if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
        # A Rosetta shell reports x86_64 on an Apple Silicon machine; install the native build.
        if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
            arch="arm64"
        fi
    fi

    # Git Bash and MSYS2 run as emulated x64 on Windows ARM64, so `uname -m` reports x86_64.
    if [ "$os" = "windows" ] && [ "$arch" = "x64" ]; then
        if [[ "$raw_os" == *-ARM64 || "${PROCESSOR_IDENTIFIER:-}" == ARM* ]]; then
            arch="arm64"
        fi
    fi

    combo="$os-$arch"
    case "$combo" in
        linux-x64|darwin-x64|windows-x64) ;;
        *) error "Unsupported OS/Arch: $os/$arch" ;;
    esac

    is_musl=false
    if [ "$os" = "linux" ]; then
        if [ -f /etc/alpine-release ]; then
            is_musl=true
        fi
        if command -v ldd >/dev/null 2>&1; then
            if ldd --version 2>&1 | grep -qi musl; then
                is_musl=true
            fi
        fi
    fi

    needs_baseline=false
    if [ "$arch" = "x64" ]; then
        if [ "$os" = "linux" ]; then
            if ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
                needs_baseline=true
            fi
        fi
        if [ "$os" = "darwin" ]; then
            if [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" != "1" ]; then
                needs_baseline=true
            fi
        fi
        if [ "$os" = "windows" ]; then
            local ps avx2
            ps="(Add-Type -MemberDefinition \"[DllImport(\\\"\\\"kernel32.dll\\\"\\\")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);\" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)"
            avx2=""
            if command -v powershell.exe >/dev/null 2>&1; then
                avx2=$(powershell.exe -NoProfile -NonInteractive -Command "$ps" 2>/dev/null || true)
            elif command -v pwsh >/dev/null 2>&1; then
                avx2=$(pwsh -NoProfile -NonInteractive -Command "$ps" 2>/dev/null || true)
            fi
            avx2=$(echo "$avx2" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
            if [ "$avx2" != "true" ] && [ "$avx2" != "1" ]; then
                needs_baseline=true
            fi
        fi
    fi

    TARGET="$os-$arch"
    if [ "$needs_baseline" = "true" ]; then
        TARGET="$TARGET-baseline"
    fi
    if [ "$is_musl" = "true" ]; then
        TARGET="$TARGET-musl"
    fi

    if [ "$os" = "linux" ]; then
        EXTENSION="tar.gz"
        BINARY_NAME="$APP"
    elif [ "$os" = "darwin" ]; then
        EXTENSION="zip"
        BINARY_NAME="$APP"
    else
        EXTENSION="zip"
        BINARY_NAME="$APP.exe"
    fi

}

# Resolves the release tag to install. The redirect of releases/latest avoids the API rate limit.
resolve_version() {
    if [ -n "$requested_version" ]; then
        TAG="$requested_version"
        case "$TAG" in
            v*) ;;
            *) TAG="v$TAG" ;;
        esac
        return
    fi

    local effective
    effective=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)
    TAG="${effective##*/}"
    if [ -z "$TAG" ] || [ "$TAG" = "latest" ] || [ "$TAG" = "$effective" ]; then
        error "Could not determine the latest release of $REPO (see https://github.com/$REPO/releases)"
    fi
}

# Uses a temporary directory next to the install directory: /tmp is a small tmpfs on many systems, and a
# release archive is larger than it can hold. TMPDIR remains available as an explicit override.
make_temp_dir() {
    local parent
    parent=$(dirname "$INSTALL_DIR")
    if mkdir -p "$parent" 2>/dev/null && tmp=$(mktemp -d "${OPENCODE_TMPDIR:-$parent}/install.XXXXXX" 2>/dev/null); then
        echo "$tmp"
        return
    fi
    mktemp -d 2>/dev/null || mktemp -d -t opencode
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo ""
    fi
}

install_cleanup() {
    if [ -n "${tmp_dir:-}" ] && [ -d "$tmp_dir" ]; then
        rm -rf "$tmp_dir"
    fi
}

install_from_binary() {
    local installed_binary="$APP"
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) installed_binary="$APP.exe" ;;
    esac
    mkdir -p "$INSTALL_DIR"
    cp "$binary_path" "$INSTALL_DIR/$installed_binary"
    chmod 755 "$INSTALL_DIR/$installed_binary"
    print_message success "Installed $APP from $binary_path"
}

download_and_install() {
    local asset url tmp expected actual
    asset="$APP-$TARGET.$EXTENSION"
    url="https://github.com/$REPO/releases/download/$TAG/$asset"

    if ! command -v curl >/dev/null 2>&1; then
        error "'curl' is required but not installed"
    fi
    if [ "$EXTENSION" = "tar.gz" ] && ! command -v tar >/dev/null 2>&1; then
        error "'tar' is required but not installed"
    fi
    if [ "$EXTENSION" = "zip" ] && ! command -v unzip >/dev/null 2>&1; then
        error "'unzip' is required but not installed"
    fi

    tmp_dir=$(make_temp_dir)
    trap install_cleanup EXIT

    print_message info "Downloading $APP $TAG ($TARGET)"
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "$tmp_dir/$asset" "$url"; then
        error "Could not download $url"
    fi

    if curl -fsSL --retry 2 -o "$tmp_dir/SHA256SUMS" "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS" 2>/dev/null; then
        expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp_dir/SHA256SUMS" | head -n 1)
        actual=$(sha256_of "$tmp_dir/$asset")
        if [ -n "$expected" ] && [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
            error "Checksum mismatch for $asset (expected $expected, got $actual)"
        fi
        if [ -n "$expected" ]; then
            print_message info "Checksum verified"
        fi
    else
        print_message warning "Warning: SHA256SUMS not published for $TAG; skipping verification"
    fi

    case "$EXTENSION" in
        tar.gz) tar -xzf "$tmp_dir/$asset" -C "$tmp_dir" ;;
        zip) unzip -oq "$tmp_dir/$asset" -d "$tmp_dir" ;;
    esac

    if [ ! -f "$tmp_dir/$BINARY_NAME" ]; then
        error "The archive did not contain $BINARY_NAME"
    fi

    mkdir -p "$INSTALL_DIR"
    mv "$tmp_dir/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
    chmod 755 "$INSTALL_DIR/$BINARY_NAME"

    # The macOS builds are cross-compiled and unsigned, so give the binary an ad-hoc signature and
    # clear any quarantine flag; without it Gatekeeper refuses to start it on Apple Silicon.
    if [ "$(uname -s)" = "Darwin" ]; then
        xattr -dr com.apple.quarantine "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || true
        codesign --force --sign - "$INSTALL_DIR/$BINARY_NAME" >/dev/null 2>&1 || true
    fi

    print_message success "Installed $APP $TAG to $INSTALL_DIR/$BINARY_NAME"
}

add_to_path() {
    local config_file=$1
    local command=$2

    if grep -Fxq "$command" "$config_file"; then
        print_message info "Command already exists in $config_file, skipping write."
    elif [[ -w $config_file ]]; then
        {
            echo -e "\n# opencode"
            echo "$command"
        } >> "$config_file"
        path_added=true
        print_message info "Successfully added opencode to \$PATH in $config_file"
    else
        print_message warning "Manually add the directory to $config_file (or similar):"
        print_message info "  $command"
    fi
}

setup_path() {
    if [[ "$no_modify_path" == "true" ]]; then
        return
    fi
    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        return
    fi

    local XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
    local current_shell config_files config_file new_config_file
    current_shell=$(basename "${SHELL:-sh}")
    case $current_shell in
        fish) config_files="$HOME/.config/fish/config.fish" ;;
        zsh) config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv" ;;
        bash) config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile" ;;
        ash|sh) config_files="$HOME/.ashrc $HOME/.profile /etc/profile" ;;
        *) config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile" ;;
    esac

    config_file=""
    for file in $config_files; do
        if [[ -f $file ]]; then
            config_file=$file
            break
        fi
    done

    # A new Mac has no ~/.zshrc, so create the shell's main config file rather than leaving opencode off PATH.
    if [[ -z $config_file ]]; then
        case $current_shell in
            zsh) new_config_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
            fish) new_config_file="$HOME/.config/fish/config.fish" ;;
            *) new_config_file="" ;;
        esac
        if [[ -n $new_config_file ]] && mkdir -p "$(dirname "$new_config_file")" 2>/dev/null && touch "$new_config_file" 2>/dev/null; then
            config_file=$new_config_file
        fi
    fi

    if [[ -z $config_file ]]; then
        print_message warning "No config file found for $current_shell. You may need to manually add to PATH:"
        print_message info "  export PATH=$INSTALL_DIR:\$PATH"
        return
    fi

    case $current_shell in
        fish) add_to_path "$config_file" "fish_add_path $INSTALL_DIR" ;;
        *) add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH" ;;
    esac
}

# `opencode2` was the pre-2.0 command name; keep it working for scripts that still call it.
install_legacy_shim() {
    local shim_os=""
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) shim_os="windows" ;;
    esac
    rm -f "$INSTALL_DIR/opencode2" "$INSTALL_DIR/opencode2.exe" "$INSTALL_DIR/opencode2.cmd"
    if [ "$shim_os" = "windows" ]; then
        cat > "$INSTALL_DIR/opencode2.cmd" <<'EOF'
@echo off
"%~dp0opencode.exe" %*
exit /b %errorlevel%
EOF
        return
    fi
    cat > "$INSTALL_DIR/opencode2" <<'EOF'
#!/bin/sh
exec "$(dirname "$0")/opencode" "$@"
EOF
    chmod 755 "$INSTALL_DIR/opencode2"
}

path_added=false

if [ "$print_target" = "true" ]; then
    detect_target
    echo "$APP-$TARGET.$EXTENSION"
    exit 0
fi

if [ -n "$binary_path" ]; then
    if [ ! -f "$binary_path" ]; then
        error "Binary not found at $binary_path"
    fi
    install_from_binary
else
    detect_target
    resolve_version
    download_and_install
fi

install_legacy_shim
setup_path

if [ -n "${GITHUB_ACTIONS-}" ] && [ "${GITHUB_ACTIONS}" = "true" ]; then
    echo "$INSTALL_DIR" >> "$GITHUB_PATH"
    print_message info "Added $INSTALL_DIR to \$GITHUB_PATH"
fi

echo ""
if [[ $path_added == "true" ]]; then
    echo -e "exec \$SHELL   ${MUTED}# Reload PATH (or open a new terminal)${NC}"
fi
echo -e "opencode      ${MUTED}# Run command${NC}"
echo -e "${MUTED}ROKFOSS AI:${NC} run ${MUTED}/connect${NC}, pick ${MUTED}ROKFOSS AI${NC}, then paste your ${MUTED}rai-...${NC} key."
echo -e "${MUTED}Releases:${NC} https://github.com/$REPO/releases"
echo ""
