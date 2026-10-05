# Third-Party Components

The main extension and modifications retain the upstream MIT license. The following components are exceptions; their original copyright notices and license texts must travel with redistributions, including extension-only ZIPs.

| Component | Location | Notices |
| --- | --- | --- |
| fflate 0.8.3 | extension/lib/fflate.js | extension/lib/fflate-LICENSE.txt (MIT) |
| opencc-js 1.4.2 + dictionaries | extension/lib/opencc.js | extension/lib/opencc-LICENSE.txt, opencc-THIRD-PARTY.txt, opencc-APACHE.txt |
| JavascriptSubtitlesOctopus / compiled libraries | extension/lib/octopus/ | Embedded wrapper header and THIRD_PARTY_LICENSES.txt; includes MIT/Expat, FTL, ISC, NTP, zlib, BSL and LGPL-2.1-or-later components, notably FriBidi |
| Arimo, Cousine, Tinos | extension/lib/octopus/*.ttf | Arimo-OFL.txt, Cousine-OFL.txt, Tinos-OFL.txt (SIL OFL 1.1); copyright years retained from the bundled fonts |

Sources: https://github.com/101arrowz/fflate , https://github.com/nk2028/opencc-js , https://github.com/libass/JavascriptSubtitlesOctopus , https://github.com/googlefonts/arimo , https://github.com/googlefonts/cousine , https://github.com/googlefonts/tinos .

## Renderer Source and Replacement

The bundled worker WASM SHA-256 is `62892886b4a75dbc6a92e12fcd794c7ddaf95f395e09d4a75612c572612f42a9`, equal to the worker WASM in the npm `libass-wasm@4.1.0` distribution. The store's wrapper filename/header is retained unchanged; no claim is made that its wrapper bytes equal npm's wrapper.

Renderer source tag: https://github.com/libass/JavascriptSubtitlesOctopus/tree/4.1.0 (commit `f5ead60c287fd6b84d4561a3b4fcc65dcd0d1f54`). Obtain the submodules too: `git clone --branch 4.1.0 --recurse-submodules https://github.com/libass/JavascriptSubtitlesOctopus.git`. Follow that project's Docker/Emscripten build instructions. Dependency refs and build scripts belong to that source tree. A corresponding source archive including the pinned dependency sources is supplied alongside this project's Beta binary release; see the release notes for its digest.

Users may inspect, modify, rebuild and replace these renderer files. This extension is unpacked and has no renderer signature/lock. Replace the compatible `subtitles-octopus.js`, worker JS and WASM in `extension/lib/octopus/`, retaining the expected filenames or updating manifest/resource references; reload the extension and playback tab. Do not disable browser security to make a replacement work. Reverse engineering necessary to debug modifications to LGPL components is not prohibited by this project. Other components remain under their own licenses.

Do not remove copyright headers, font licenses, LGPL text or source/replacement information when distributing a derivative. If the compiled libraries change, refresh their source references and license/source artifacts instead of reusing this notice blindly.
