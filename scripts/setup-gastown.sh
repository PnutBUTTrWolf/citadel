#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  VSMax - Gastown Terminal IDE
#  Licensed under the MIT License.
#---------------------------------------------------------------------------------------------
#
# Bootstrap script for Gastown local development.
#
# Prerequisites you must supply yourself:
#   - Claude Code CLI, authenticated (gt spawns claude processes for agent work;
#     the chat participant also calls claude --print as its default backend)
#
# This script installs:
#   - Go 1.24+            (via Homebrew on macOS, apt on Linux)
#   - Dolt                (version-controlled SQL database, used by Beads)
#   - gt CLI              (Gastown workspace manager)
#   - bd CLI              (Beads issue tracker)
#
# It then initialises a Gastown workspace at ~/gt.
#
# Usage:
#   ./scripts/setup-gastown.sh            # interactive
#   NONINTERACTIVE=1 ./scripts/setup-gastown.sh   # CI / headless

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

GT_WORKSPACE="${GT_WORKSPACE:-$HOME/gt}"

info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
fail()  { printf "${RED}[fail]${NC}  %s\n" "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Detect platform
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      fail "Unsupported OS: $OS" ;;
esac

# ---------------------------------------------------------------------------
# 1. Go
# ---------------------------------------------------------------------------
install_go() {
    info "Installing Go..."
    if [[ "$PLATFORM" == "macos" ]]; then
        if ! command -v brew &>/dev/null; then
            fail "Homebrew is required on macOS. Install it from https://brew.sh"
        fi
        brew install go
    else
        sudo apt-get update -qq && sudo apt-get install -y -qq golang-go
    fi
}

if command -v go &>/dev/null; then
    GO_VER="$(go version | grep -oE '[0-9]+\.[0-9]+' | head -1)"
    GO_MAJOR="${GO_VER%%.*}"
    GO_MINOR="${GO_VER##*.}"
    if (( GO_MAJOR < 1 )) || { (( GO_MAJOR == 1 )) && (( GO_MINOR < 24 )); }; then
        warn "Go $GO_VER found but 1.24+ is required"
        install_go
    else
        ok "Go $GO_VER"
    fi
else
    install_go
fi

# Ensure GOPATH/bin is in PATH for the rest of this script
export PATH="${GOPATH:-$HOME/go}/bin:$PATH"

# ---------------------------------------------------------------------------
# 1b. tmux (terminal multiplexer, required for agent sessions)
# ---------------------------------------------------------------------------
if command -v tmux &>/dev/null; then
    ok "tmux $(tmux -V 2>/dev/null || echo '(installed)')"
else
    info "Installing tmux..."
    if [[ "$PLATFORM" == "macos" ]]; then
        brew install tmux
    else
        sudo apt-get update -qq && sudo apt-get install -y -qq tmux
    fi
    ok "tmux installed"
fi

# ---------------------------------------------------------------------------
# 2. gt (Gastown CLI)
# ---------------------------------------------------------------------------
# Note: We clone and build locally instead of using 'go install ...@latest'
# because the gastown go.mod contains replace directives, which Go disallows
# for remote module installs.  We use 'make build' so that ldflags (Version,
# Commit, BuiltProperly) are set and the binary is code-signed on macOS.
if command -v gt &>/dev/null; then
    ok "gt $(gt version 2>/dev/null || echo '(installed)')"
else
    info "Installing gt CLI..."
    GT_TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$GT_TMPDIR"' EXIT
    git clone --depth 1 https://github.com/steveyegge/gastown.git "$GT_TMPDIR/gastown"
    (cd "$GT_TMPDIR/gastown" && make build SKIP_UPDATE_CHECK=1 && cp gt "${GOPATH:-$HOME/go}/bin/gt")
    rm -rf "$GT_TMPDIR"
    trap - EXIT
    ok "gt installed"
fi

# ---------------------------------------------------------------------------
# 3. Dolt (version-controlled SQL database, required by Beads)
# ---------------------------------------------------------------------------
if command -v dolt &>/dev/null; then
    ok "dolt $(dolt version 2>/dev/null | head -1 || echo '(installed)')"
else
    info "Installing Dolt..."
    if [[ "$PLATFORM" == "macos" ]]; then
        brew install dolt
    else
        sudo bash -c 'curl -L https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash'
    fi
    ok "dolt installed"
fi

# ---------------------------------------------------------------------------
# 4. bd (Beads issue tracker) — requires ICU libraries for go-icu-regex
# ---------------------------------------------------------------------------
find_icu_prefix() {
    # Try pkg-config first (most reliable)
    if command -v pkg-config &>/dev/null; then
        local pc_prefix
        pc_prefix="$(pkg-config --variable=prefix icu-uc 2>/dev/null || true)"
        if [[ -n "$pc_prefix" ]] && [[ -d "$pc_prefix/include/unicode" ]]; then
            echo "$pc_prefix"
            return
        fi
    fi

    # Ask brew directly — handles any version (icu4c, icu4c@78, etc.)
    local p
    p="$(brew --prefix icu4c 2>/dev/null || true)"
    if [[ -n "$p" ]] && [[ -d "$p/include/unicode" ]]; then
        echo "$p"
        return
    fi
}

if command -v bd &>/dev/null; then
    ok "bd $(bd version 2>/dev/null || echo '(installed)')"
else
    if [[ "$PLATFORM" == "macos" ]]; then
        ICU_PREFIX="$(find_icu_prefix)"
        if [[ -z "$ICU_PREFIX" ]]; then
            info "Installing ICU libraries (required by bd)..."
            brew install icu4c
            ICU_PREFIX="$(find_icu_prefix)"
        fi
        if [[ -z "$ICU_PREFIX" ]]; then
            fail "Could not locate ICU headers after install. Run 'brew info icu4c' to check the prefix and set CGO_CFLAGS/CGO_LDFLAGS manually."
        fi
        ok "ICU found at $ICU_PREFIX"
        export CGO_CFLAGS="-I${ICU_PREFIX}/include"
        export CGO_CXXFLAGS="-I${ICU_PREFIX}/include"
        export CGO_LDFLAGS="-L${ICU_PREFIX}/lib"
    else
        if ! dpkg -s libicu-dev &>/dev/null 2>&1; then
            info "Installing ICU libraries (required by bd)..."
            sudo apt-get install -y -qq libicu-dev
        fi
    fi

    info "Installing bd CLI..."
    # Clone and build locally — same reason as gt: beads go.mod may contain
    # replace directives that prevent 'go install ...@latest'.
    # Use 'make build' so ldflags (Build hash) are set and binary is code-signed on macOS.
    BD_TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$BD_TMPDIR"' EXIT
    git clone --depth 1 https://github.com/steveyegge/beads.git "$BD_TMPDIR/beads"
    (cd "$BD_TMPDIR/beads" && make build && cp bd "${GOPATH:-$HOME/go}/bin/bd")
    rm -rf "$BD_TMPDIR"
    trap - EXIT
    ok "bd installed"
fi

# ---------------------------------------------------------------------------
# 5. Initialise Gastown workspace
# ---------------------------------------------------------------------------
if [[ -d "$GT_WORKSPACE" ]]; then
    ok "Gastown workspace exists at $GT_WORKSPACE"
else
    info "Creating Gastown workspace at $GT_WORKSPACE..."
    gt install "$GT_WORKSPACE"
    ok "Workspace created"
fi

# ---------------------------------------------------------------------------
# 6. Health check and auto-fix
# ---------------------------------------------------------------------------
info "Running gt doctor..."
if (cd "$GT_WORKSPACE" && gt doctor); then
    ok "Gastown health check passed"
else
    info "Attempting auto-fix with gt doctor --fix..."
    (cd "$GT_WORKSPACE" && gt doctor --fix) || true
    if (cd "$GT_WORKSPACE" && gt doctor); then
        ok "Gastown health check passed after fix"
    else
        warn "gt doctor still reports issues — review the output above"
    fi
fi

# ---------------------------------------------------------------------------
# 7. PATH reminder
# ---------------------------------------------------------------------------

GOBIN="${GOPATH:-$HOME/go}/bin"
if [[ ":$PATH:" != *":$GOBIN:"* ]]; then
    SHELL_RC=""
    case "$(basename "${SHELL:-/bin/bash}")" in
        zsh)  SHELL_RC="$HOME/.zshrc" ;;
        bash)
            if [[ -f "$HOME/.bash_profile" ]]; then
                SHELL_RC="$HOME/.bash_profile"
            else
                SHELL_RC="$HOME/.bashrc"
            fi
            ;;
    esac

    EXPORT_LINE="export PATH=\"\$PATH:$GOBIN\""

    if [[ -n "$SHELL_RC" ]]; then
        if ! grep -qF "$GOBIN" "$SHELL_RC" 2>/dev/null; then
            echo "" >> "$SHELL_RC"
            echo "# Added by Gastown setup" >> "$SHELL_RC"
            echo "$EXPORT_LINE" >> "$SHELL_RC"
            ok "Added $GOBIN to PATH in $SHELL_RC"
        fi
        export PATH="$PATH:$GOBIN"
    else
        warn "Could not detect shell config file. Add this to your shell profile manually:"
        echo ""
        echo "  $EXPORT_LINE"
        echo ""
    fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
ok "Gastown setup complete!"
echo ""
info "Next steps:"
echo "  1. Ensure Claude Code CLI is authenticated (run 'claude' to verify)"
echo "  2. Add a rig:        gt rig add <name> <repo-url>"
echo "  3. Build VSMax:      npm install && npm run watch"
echo "  4. Launch VSMax:     ./scripts/code.sh"
echo "  5. Open the Gastown sidebar (server-process icon) to manage agents, convoys, and rigs"
echo ""
echo "  Note: An Anthropic API key is NOT required when Claude Code CLI is installed."
echo "  The gastown.anthropicApiKey setting exists only for web/remote environments"
echo "  where the CLI is unavailable."
echo ""
