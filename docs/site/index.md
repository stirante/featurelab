---
layout: home
title: Feature Lab
titleTemplate: Bedrock worldgen features, measured
hero:
  name: Feature Lab
  text: Bedrock worldgen features, measured.
  tagline: One page per feature type, every claim pinned to Minecraft Bedrock 1.26.50.24 and reproducible from a committed fixture pack. Plus the engine that measures them and the editor that shows them.
  actions:
    - theme: brand
      text: Feature types
      link: /features/
    - theme: alt
      text: Scatter feature
      link: /features/scatter_feature
    - theme: alt
      text: Engine & CLI
      link: /engine/
features:
  - title: Feature types
    details: What each of the 29 JSON feature types does, how many random draws it spends and in what order, what its fields default to, and how it fails while looking correct. The core of this site.
    link: /features/
  - title: The engine and its CLI
    details: A Go reimplementation of the game's feature placement that loads a pack, builds a bench world and runs one feature or one rule in it — and says, in a diagnostic, everything it declined to do.
    link: /engine/
  - title: The editor
    details: A VS Code extension and a desktop app around the same viewer — a graph of your pack's features as cards you can edit, and a 3D preview of what one of them places.
    link: /editor/
---
