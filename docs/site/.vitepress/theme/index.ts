// The default theme plus the components pages use: the version badge (front matter -> pill), the
// coverage badge (generated/coverage.json -> pill), and the playground (<Playground example="..."/>),
// which a page embeds where a reader should try a feature for themselves. Nothing else is
// customised; the point is the pages, not the chrome.
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import VersionBadge from './components/VersionBadge.vue'
import CoverageBadge from './components/CoverageBadge.vue'
import Playground from './components/Playground.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VersionBadge', VersionBadge)
    app.component('CoverageBadge', CoverageBadge)
    app.component('Playground', Playground)
  },
} satisfies Theme
