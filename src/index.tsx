import { registerSidebarEntry, registerRoute } from '@kinvolk/headlamp-plugin/lib';
import TcpdumpCapturePage from './components/TcpdumpCapture';

registerSidebarEntry({
    parent: null,
    name: 'tcpdump-capture',
    label: 'kubexm网络抓包',
    url: '/tcpdump-capture',
    icon: 'mdi:bug-outline',
});

registerRoute({
    path: '/tcpdump-capture',
    sidebar: 'tcpdump-capture',
    name: 'tcpdump-capture',
    exact: true,
    component: TcpdumpCapturePage,
});