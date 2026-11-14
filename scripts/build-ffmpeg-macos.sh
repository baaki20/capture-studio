#!/usr/bin/env bash
# Builds the GPL FFmpeg and ffprobe that macOS packages ship (spec §1.10, Phase 3 plan D6).
# BtbN publishes no macOS builds, so we build the same FFmpeg revision as the Linux and Windows
# pins, with the encoders the app uses (libx264, libx265, libvpx-vp9, libsvtav1, libopus,
# libmp3lame) linked statically and VideoToolbox/AudioToolbox from the system. The binaries
# depend only on macOS system libraries and frameworks, which the last step checks.
#
#   scripts/build-ffmpeg-macos.sh <out-dir>
#
# Run on the architecture to build (arm64 or x86_64); CI runs it on both
# (.github/workflows/ffmpeg-macos.yml). Needs Xcode command-line tools plus cmake, nasm and
# pkg-config (build tools only; nothing from Homebrew is linked). Writes
# <out-dir>/ffmpeg-<version>-macos-<arch>-gpl.tar.xz and its .sha256; pin those in
# scripts/ffmpeg-manifest.json once the archive is published.
set -euo pipefail

# Every source is pinned to a commit (git checks the content) or a SHA-256.
FFMPEG_COMMIT=7adfbe40dcde598f93a6963d2f7b22cd75202ccc # n9.0.2-39, release/9.0
FFMPEG_VERSION=n9.0.2-39-g7adfbe40dc
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55   # stable branch (fails if it moves)
X265_COMMIT=e444744c03978c1fb4e037168967020cf2648427   # 4.2
LIBVPX_COMMIT=1024874c5919305883187e2953de8fcb4c3d7fa6 # v1.16.0
SVTAV1_COMMIT=e3d63405f9ba8219913a7276c2c47d10e5d022fe # v4.3.0
OPUS_COMMIT=22244de5a79bd1d6d623c32e72bf1954b56235be   # v1.6.1
LAME_URL=https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e

OUT=$(mkdir -p "${1:?usage: build-ffmpeg-macos.sh <out-dir>}" && cd "$1" && pwd)
ARCH=$(uname -m)
case "$ARCH" in arm64) PKG_ARCH=arm64 ;; x86_64) PKG_ARCH=x64 ;; *) echo "unsupported $ARCH" >&2; exit 1 ;; esac
export MACOSX_DEPLOYMENT_TARGET=13.0
JOBS=$(sysctl -n hw.ncpu)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cs-ffmpeg.XXXXXX")
PREFIX="$WORK/prefix"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH" # never pick up Homebrew's .pc files
trap 'rm -rf "$WORK"' EXIT

# Fetches a tag or branch (not every host serves a bare commit) and insists on the pinned commit.
checkout() { # <name> <repository> <ref> <commit>
  git init -q "$WORK/$1"
  # Tags are fetched as tags: x265 installs x265.pc only when `git describe` finds its version.
  case "$3" in
  refs/tags/*) git -C "$WORK/$1" fetch -q --depth 1 "$2" "+$3:$3" ;;
  *) git -C "$WORK/$1" fetch -q --depth 1 "$2" "$3" ;;
  esac
  git -C "$WORK/$1" checkout -q FETCH_HEAD
  local got
  got=$(git -C "$WORK/$1" rev-parse HEAD)
  if [ "$got" != "$4" ]; then
    echo "$1: $3 is $got, expected $4 (moved upstream: re-pin deliberately)" >&2
    exit 1
  fi
}

cmake_static() { # <source dir> [cmake args…]
  local src=$1
  shift
  cmake -S "$src" -B "$src/build" -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$src/build" -j "$JOBS"
  cmake --install "$src/build"
}

echo "== x264"
checkout x264 https://code.videolan.org/videolan/x264.git refs/heads/stable "$X264_COMMIT"
(cd "$WORK/x264" && ./configure --prefix="$PREFIX" --enable-static --enable-pic --disable-cli &&
  make -j "$JOBS" && make install)

echo "== x265"
checkout x265 https://bitbucket.org/multicoreware/x265_git.git refs/tags/4.2 "$X265_COMMIT"
cmake_static "$WORK/x265/source" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF

echo "== libvpx"
checkout libvpx https://github.com/webmproject/libvpx.git refs/tags/v1.16.0 "$LIBVPX_COMMIT"
(cd "$WORK/libvpx" && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
  --enable-pic --enable-vp9-highbitdepth --disable-examples --disable-tools --disable-docs \
  --disable-unit-tests && make -j "$JOBS" && make install)

echo "== SVT-AV1"
checkout svtav1 https://gitlab.com/AOMediaCodec/SVT-AV1.git refs/tags/v4.3.0 "$SVTAV1_COMMIT"
cmake_static "$WORK/svtav1" -DBUILD_APPS=OFF -DBUILD_TESTING=OFF

echo "== opus"
checkout opus https://github.com/xiph/opus.git refs/tags/v1.6.1 "$OPUS_COMMIT"
cmake_static "$WORK/opus" -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF

echo "== lame"
mkdir "$WORK/lame-dl"
curl -fsSL -o "$WORK/lame-dl/lame.tar.gz" "$LAME_URL"
echo "$LAME_SHA256  $WORK/lame-dl/lame.tar.gz" | shasum -a 256 -c -
tar -xzf "$WORK/lame-dl/lame.tar.gz" -C "$WORK"
# 3.100 lists a symbol it no longer defines; Apple's linker refuses the export list.
sed -i '' '/lame_init_old/d' "$WORK/lame-3.100/include/libmp3lame.sym"
(cd "$WORK/lame-3.100" && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
  --disable-frontend --disable-decoder && make -j "$JOBS" && make install)

echo "== FFmpeg $FFMPEG_VERSION"
checkout ffmpeg https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_COMMIT" "$FFMPEG_COMMIT"
# x265 is C++: its static library needs the C++ runtime at link time.
(cd "$WORK/ffmpeg" && ./configure --prefix="$PREFIX" --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" --extra-libs=-lc++ \
  --enable-gpl --enable-version3 --enable-static --disable-shared --disable-ffplay \
  --disable-doc --disable-debug --enable-libx264 --enable-libx265 --enable-libvpx \
  --enable-libsvtav1 --enable-libopus --enable-libmp3lame --enable-videotoolbox \
  --enable-audiotoolbox && make -j "$JOBS" && make install)

echo "== package"
ROOT="ffmpeg-$FFMPEG_VERSION-macos-$PKG_ARCH-gpl"
STAGE="$WORK/stage/$ROOT"
mkdir -p "$STAGE/bin"
cp "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$STAGE/bin/"
cp "$WORK/ffmpeg/COPYING.GPLv3" "$STAGE/LICENSE.txt"
cat >"$STAGE/BUILD-SOURCES.txt" <<EOF
FFmpeg $FFMPEG_COMMIT (https://github.com/FFmpeg/FFmpeg)
x264 $X264_COMMIT (https://code.videolan.org/videolan/x264)
x265 $X265_COMMIT (https://bitbucket.org/multicoreware/x265_git)
libvpx $LIBVPX_COMMIT (https://github.com/webmproject/libvpx)
SVT-AV1 $SVTAV1_COMMIT (https://gitlab.com/AOMediaCodec/SVT-AV1)
opus $OPUS_COMMIT (https://github.com/xiph/opus)
lame 3.100 sha256 $LAME_SHA256 ($LAME_URL)
Built with scripts/build-ffmpeg-macos.sh, macOS deployment target $MACOSX_DEPLOYMENT_TARGET.
EOF

# Only system libraries and frameworks may be linked.
for bin in "$STAGE"/bin/*; do
  if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
    echo "$bin links a non-system library" >&2
    exit 1
  fi
done
encoders=$("$STAGE/bin/ffmpeg" -hide_banner -encoders)
for e in libx264 libx265 libvpx-vp9 libsvtav1 libopus libmp3lame h264_videotoolbox; do
  grep -qw -- "$e" <<<"$encoders" || { echo "encoder $e is missing" >&2; exit 1; }
done
"$STAGE/bin/ffmpeg" -hide_banner -version | head -1

tar -C "$WORK/stage" -cJf "$OUT/$ROOT.tar.xz" "$ROOT"
(cd "$OUT" && shasum -a 256 "$ROOT.tar.xz" >"$ROOT.tar.xz.sha256" && cat "$ROOT.tar.xz.sha256")
for bin in ffmpeg ffprobe LICENSE.txt; do
  f="$STAGE/$bin"
  [ -e "$f" ] || f="$STAGE/bin/$bin"
  echo "$bin $(shasum -a 256 "$f" | awk '{print $1}')"
done
