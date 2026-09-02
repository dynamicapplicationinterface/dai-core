import DefaultTheme from 'vitepress/theme';
import Playground from '../../components/Playground.vue';
import DownloadCard from '../../components/DownloadCard.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: any }) {
    app.component('Playground', Playground);
    app.component('DownloadCard', DownloadCard);
  }
};
