{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {
      inherit system;
    };
  in {
    devShells.${system}.default = pkgs.mkShell {
      name = "compress";
      packages = with pkgs; [
        nodejs
        tailwindcss
        yarn
        yarn2nix
      ];
    };
    packages.default = import ./default.nix;
  };
}
