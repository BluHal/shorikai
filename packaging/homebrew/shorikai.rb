cask "shorikai" do
  version "0.1.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

  url "https://github.com/BluHal/shorikai/releases/download/v#{version}/Shorikai_#{version}_universal.dmg",
      verified: "github.com/BluHal/shorikai/"
  name "Shorikai"
  desc "AI agent cockpit"
  homepage "https://github.com/BluHal/shorikai"

  app "Shorikai.app"
end
