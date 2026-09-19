<script setup lang="ts">
// The version pin, as a badge instead of a paragraph -- but the paragraph's content is what
// the badge says. Read from the page's front matter:
//
//   game: "1.26.50.24"          the Bedrock version the page is a statement about (required
//                               on every page whose scope is the game)
//   alsoHolds: ["1.26.40.26"]   versions the page has been checked against and found identical
//   scope: game | bench         a `bench` page is about the tool, not Minecraft, and its badge
//                               says so instead of naming a game version
//   recheck: true               the page was written against an older target and has not yet
//                               been re-checked against `game` -- the wiki index's own caveat,
//                               made visible on the page it applies to
import { useData } from 'vitepress'
import { computed } from 'vue'

const { frontmatter, site } = useData()
const scope = computed(() => (frontmatter.value.scope as string | undefined) ?? 'game')
const game = computed(() => (frontmatter.value.game as string | undefined) ?? '')
const alsoHolds = computed(() => (frontmatter.value.alsoHolds as string[] | undefined) ?? [])
const recheck = computed(() => frontmatter.value.recheck === true)
</script>

<template>
  <div class="fl-badges" role="note">
    <template v-if="scope === 'bench'">
      <span class="fl-badge fl-badge--bench" title="This page describes the featurelab bench, not Minecraft. Nothing on it is a statement about the game.">About the bench, not the game</span>
    </template>
    <template v-else>
      <span class="fl-badge fl-badge--game" :title="`Every claim on this page is a statement about Minecraft Bedrock ${game}. Worldgen internals move between releases; nothing here should be assumed to hold for a different build without checking.`">Bedrock {{ game }}</span>
      <span v-for="v in alsoHolds" :key="v" class="fl-badge fl-badge--also" :title="`Checked against ${v} too: the JSON surface and the behaviour described here are the same in both.`">also holds for {{ v }}</span>
      <span v-if="recheck" class="fl-badge fl-badge--recheck" title="Written against an earlier target version and not yet re-checked against the one named. Treat version-sensitive claims with care.">not yet re-checked</span>
    </template>
    <slot />
  </div>
</template>
