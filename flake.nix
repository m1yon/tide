{
  description = "tide — global CLI for Sandcastle-driven, Linear-rooted PRD runs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self
    , nixpkgs
    , flake-utils
    ,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # `self.shortRev` is set when the flake is built from a clean git tree.
        # `self.dirtyShortRev` is set when the working tree has uncommitted
        # changes. Fall back to "unknown" when neither is available.
        gitRev = self.shortRev or self.dirtyShortRev or "unknown";

        # Fixed-output derivation that fetches all `node_modules` for the
        # repo. Network access is allowed because `outputHash` pins the
        # final tarball to a known hash. Update the hash whenever
        # `bun.lock` changes.
        nodeModules = pkgs.stdenv.mkDerivation {
          pname = "tide-node-modules";
          version = "0";

          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let
                relPath = pkgs.lib.removePrefix (toString ./. + "/") (toString path);
              in
              relPath == "package.json"
              || relPath == "bun.lock"
              || relPath == "patches"
              || pkgs.lib.hasPrefix "patches/" relPath;
          };

          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild

            export HOME=$TMPDIR
            bun install --frozen-lockfile --no-progress --ignore-scripts

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out
            cp -R node_modules $out/

            runHook postInstall
          '';

          # FODs must not reference store paths. Skip the default fixup
          # phase (which patches shebangs in scripts and would inject
          # references to bash from the store).
          dontFixup = true;

          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          # Hash of the resolved node_modules tree. Update whenever
          # `bun.lock` changes — `nix build` will print the new hash on
          # mismatch. To force a re-derivation, swap this for
          # `pkgs.lib.fakeSha256` and rerun `nix build`.
          outputHash = "sha256-IXjdJYgUXWcX6/PGy/jc3EDgEzBl2+5zE14XObEgt+k=";
        };

        tide = pkgs.stdenv.mkDerivation {
          pname = "tide";
          version = gitRev;

          src = ./.;

          nativeBuildInputs = [ pkgs.bun ];

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild

            export HOME=$TMPDIR

            # Symlink the prefetched node_modules so bun can resolve deps.
            ln -s ${nodeModules}/node_modules node_modules

            # bun build --compile bundles deps + Bun runtime into one binary.
            # --define replaces VERSION at compile time with the git short SHA.
            bun build \
              --compile \
              --define VERSION='"${gitRev}"' \
              --outfile tide \
              src/cli/index.ts

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/bin
            install -m755 tide $out/bin/tide

            runHook postInstall
          '';

          # Bun's compile output is a self-extracting binary that appends
          # the bundled JavaScript and metadata to the end of the file.
          # Nix's default fixup phase (RPATH shrinking, strip, patchelf)
          # corrupts that trailer and turns the binary back into a plain
          # Bun runtime that prints Bun's own help. Skip fixup entirely.
          dontFixup = true;
          dontStrip = true;
          dontPatchELF = true;

          meta = with pkgs.lib; {
            description = "Global CLI for Sandcastle-driven, Linear-rooted PRD runs";
            mainProgram = "tide";
            platforms = platforms.unix;
          };
        };
      in
      {
        packages = {
          default = tide;
          tide = tide;
        };

        apps.default = {
          type = "app";
          program = "${tide}/bin/tide";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.bun ];
        };
      }
    );
}
