{ pkgs ? (import <nixpkgs> {}).pkgs }:
let
  pname = "compress";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
  src = ./.;
  deps = pkgs.mkYarnModules {
    inherit pname version;
    packageJSON = ./package.json;
    yarnLock = ./yarn.lock;
    yarnNix = ./yarn.nix;
  };
in
pkgs.stdenv.mkDerivation {
  inherit pname version;

  nativeBuildInputs = with pkgs; [ ffmpeg nodejs ];
  buildInputs = with pkgs; [ tailwindcss ];

  configurePhase = ''
    mkdir -p $out/bin
    ln -s ${deps}/node_modules $out
  '';

  installPhase = ''
    cp -rv ${src}/static $out/bin/static
    cp -rv ${src}/src/index.js $out/bin/.compress-wrapped

    cat <<EOF > $out/bin/compress
    #!${pkgs.nodejs}/bin/node
    require("$out/bin/.compress-wrapped")
    EOF

    chmod a+x $out/bin/compress
  '';

  dontUnpack = true;
}
