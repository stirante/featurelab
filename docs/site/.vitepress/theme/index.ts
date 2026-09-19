// The default theme plus two components every page template uses: the version badge (front
// matter -> pill) and the coverage badge (generated/coverage.json -> pill). Nothing else is
// customised; the point of the pilot is the pages, not the chrome.
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import VersionBadge from './components/VersionBadge.vue'
import CoverageBadge from './components/CoverageBadge.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VersionBadge', VersionBadge)
    app.component('CoverageBadge', CoverageBadge)
  },
} satisfies Theme
