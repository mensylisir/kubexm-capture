import { registerSidebarEntry, registerRoute } from '@kinvolk/headlamp-plugin/lib';
import TcpdumpCapturePage from './components/TcpdumpCapture';

const PLUGIN_NAME = 'kubexm-capture';

registerSidebarEntry({
    parent: null,
    name: PLUGIN_NAME,
    label: '网络抓包工具',
    url: `/${PLUGIN_NAME}`,
    icon: 'mdi:bug-outline',
});

registerRoute({
    path: `/${PLUGIN_NAME}`,
    sidebar: PLUGIN_NAME,
    name: PLUGIN_NAME,
    exact: true,
    component: TcpdumpCapturePage,
});