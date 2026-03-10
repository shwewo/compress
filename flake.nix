{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }: let
    system = "aarch64-darwin";
    pkgs = import nixpkgs {
      inherit system;
    };
  in {
    devShells.${system}.default = pkgs.mkShell {
      name = "compress";
      packages = with pkgs; [
        ffmpeg
        nodejs
        tailwindcss
        yarn
        yarn2nix
      ];
    };
    packages.${system}.default = pkgs.callPackage ./default.nix {};
  };
}
