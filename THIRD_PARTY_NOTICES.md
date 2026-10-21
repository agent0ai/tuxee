# Reused source

Tuxee adapts terminal engine.ts and state.ts from the8020/dev-core commit ff0b4bcf076581b59fb5e52b7168f33958a9723f (https://github.com/the8020/dev-core). These remain matched to xterm 6.0.0. Native lifecycle and HTTPS policies are adapted from the8020/kernel and the8020/https; changes remove the platform database/sandbox dependencies. The owner requested this reuse.

The header width-fitting function in `web/overflow.ts` is reused from `the8020/uui` commit b14a6096fee6bd4f64c6b25c16064822cefb225a (`services/shell/frontend/responsive_header.ts`). The owner requested reuse of this header behavior. That repository does not supply a general redistribution license; this source is not represented as independently open-source licensed.

The CodeMirror 6 vendor chunks and language/highlighting integration come from the same the8020/uui commit, `services/shell/frontend/components/code-editor`. The matched CodeMirror/Lezer packages are MIT-licensed; their full pinned package notices are preserved in `third_party/CODEMIRROR-LICENSES.txt`. All chunks and syntax modes are bundled locally.

# Third-party notices

The embedded terminal uses `@xterm/xterm` 6.0.0, `@xterm/addon-unicode11`
0.9.0, and the matching `@xterm/headless` 6.0.0 engine. Its browser bundle and
copied styles are distributed under the MIT license.

Copyright (c) 2017-2019, The xterm.js authors
(https://github.com/xtermjs/xterm.js)

Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)

Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Additional bundled components

The GUI proof of concept bundles noVNC 1.6.0 `core/` and `vendor/` ES modules from https://github.com/novnc/noVNC/releases/tag/v1.6.0. Corresponding source is included in `web/vendor/novnc/` in this repository and is available from that upstream tag. Tuxee modifies `core/util/browser.js` to release the H.264 capability probe's frame and decoder on success/failure, and `core/rfb.js` to reject invalid framebuffer dimensions from hidden/detached viewers; the remaining bundled modules are unmodified. The core is MPL-2.0, with BSD-licensed portions and the bundled MIT-licensed pako implementation. Full notices are in `third_party/NOVNC-*`; upstream per-file notices remain in source. The Go binary serves these notices under `/licenses/`.

The POC container separately builds TigerVNC 1.16.2 (GPL-2.0 and upstream component licenses) with Xorg Server 21.1.25 (upstream X/MIT-style licenses). Exact source URLs, SHA-256 checksums, upstream integration patch and build options are in `docker/build-gui.sh`. Corresponding source archives are https://github.com/TigerVNC/tigervnc/archive/refs/tags/v1.16.2.tar.gz and https://www.x.org/releases/individual/xserver/xorg-server-21.1.25.tar.xz. The container retains their upstream license files under `/usr/local/share/licenses/tuxee-gui/`. They are separate runtime executables, not linked into Tuxee.

Verbatim licenses for GridStack (MIT), Lucide (ISC, including Feather-derived portions), the Go standard library, and the Go dependencies linked into the executable are in `third_party/`. The frontend embeds these alongside this notice under `/licenses/`. Dependency versions are pinned by package-lock.json and go.sum.

The HTTPS policy adaptation is based on the8020/https commit 7afdb86df19b608bb533017a4a48e84dc4833637 under Apache-2.0; its full license is included. Tuxee replaces the Deno runtime and ACME internals with Go/lego while preserving the public-address eligibility and persistent fallback contract.

The owner authorized reuse from the8020/dev-core and the8020/kernel. Those inspected source trees do not supply a general redistribution license; their code is not represented here as independently open-source licensed. The dev-core snapshot/interpreter source is retained with import/runtime adaptation. The Docker Bash login prompt adapts `defaults/config/runtime/development/image/files/profile` from that kernel tree. Kernel lifetime contracts are adapted to PAM and local retained PTYs. Distributed identity, sandbox, database and routing dependencies are omitted.

Terminal window discovery and activation use github.com/jezek/xgb v1.3.1 (XGB, BSD-3-Clause). The exact upstream license is in `third_party/XGB-LICENSE.txt` and is served under `/licenses/`.
