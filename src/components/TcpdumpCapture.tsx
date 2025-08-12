import React from 'react';
import {
    Box, Button, CircularProgress, Paper, TextField, Typography, Alert,
    Table, TableBody, TableCell, TableContainer, TableHead, TableRow
} from '@mui/material';
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { K8s } from '@kinvolk/headlamp-plugin/lib';

const DS_NAME = 'tcpdump-capture-ds';
const DS_NAMESPACE = 'kubexm-capture';
const DS_LABEL_SELECTOR = 'app=tcpdump-capture';
const BACKEND_SERVICE_NAME = 'kubexm-capture-backend-svc';
const BACKEND_SERVICE_NAMESPACE = 'tcm';
const CLEANUP_DS_NAME = 'pcap-cleanup-ds';

function getTcpdumpDaemonSetSpec(filter: string, image: string) {
    const pcapFilePath = `/captures/\${NODE_NAME}.pcap`;
    return {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata: { name: DS_NAME, namespace: DS_NAMESPACE },
        spec: {
            selector: { matchLabels: { app: 'tcpdump-capture' } },
            template: {
                metadata: { labels: { app: 'tcpdump-capture' } },
                spec: {
                    hostNetwork: true,
                    hostPID: true,
                    tolerations: [
                        { key: 'node-role.kubernetes.io/master', effect: 'NoSchedule' },
                        { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }
                    ],
                    volumes: [{ name: 'capture-storage', hostPath: { path: '/tmp/captures', type: 'DirectoryOrCreate' } }],
                    containers: [{
                        name: 'tcpdump-container',
                        image: image,
                        command: ["/bin/sh", "-c"],
                        args: [
                            `echo "Cleaning up old capture file: ${pcapFilePath}" && ` +
                            `rm -f "${pcapFilePath}" && ` +
                            `echo 'Starting tcpdump on all interfaces (any) with filter: ${filter}' && tcpdump -i any -s0 -w "/captures/\${NODE_NAME}.pcap" '${filter}'`
                        ],
                        env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } }],
                        volumeMounts: [{ name: 'capture-storage', mountPath: '/captures' }],
                        securityContext: { privileged: true },
                    }],
                },
            },
        },
    };
}

function getCleanupDaemonSetSpec(image: string) {
    return {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata: {
            name: CLEANUP_DS_NAME,
            namespace: DS_NAMESPACE,
        },
        spec: {
            selector: { matchLabels: { app: 'pcap-cleanup' } },
            template: {
                metadata: { labels: { app: 'pcap-cleanup' } },
                spec: {
                    tolerations: [{ operator: "Exists" }],
                    containers: [{
                        name: 'cleanup-container',
                        image: image,
                        command: ["/bin/sh", "-c"],
                        args: [
                            'echo "Cleaning up pcap files in /host/tmp/captures..."; rm -f /host/tmp/captures/*.pcap; echo "Cleanup complete. Pod will now terminate."; sleep 5'
                        ],
                        volumeMounts: [{
                            name: 'host-tmp',
                            mountPath: '/host/tmp',
                        }],
                    }],
                    volumes: [{
                        name: 'host-tmp',
                        hostPath: { path: '/tmp' },
                    }],
                },
            },
        },
    };
}

type K8sService = InstanceType<typeof K8s.ResourceClasses.Service>;

type K8sPod = InstanceType<typeof K8s.ResourceClasses.Pod>;

export default function TcpdumpCapturePage() {
    const [isDsRunning, setIsDsRunning] = React.useState<boolean>(false);
    const [isLoading, setIsLoading] = React.useState<boolean>(true);
    const [error, setError] = React.useState<string | null>(null);
    const [isDownloading, setIsDownloading] = React.useState<boolean>(false);

    const [captureFilter, setCaptureFilter] = React.useState(''); //tcp port 80 or tcp port 443
    const [captureImage, setCaptureImage] = React.useState('registry.dev.rdev.tech:18093/headlamp/universal-toolkit:1.0');

    const [pods, setPods] = React.useState<K8sPod[]>([]);
    const [progress, setProgress] = React.useState<string>('');

    const dsUrl = `/apis/apps/v1/namespaces/${DS_NAMESPACE}/daemonsets/${DS_NAME}`;
    const nsUrl = `/api/v1/namespaces/${DS_NAMESPACE}`;
    const podsUrl = `/api/v1/namespaces/${DS_NAMESPACE}/pods?labelSelector=${DS_LABEL_SELECTOR}`;

    const checkDaemonSetStatus = React.useCallback(async () => {
        setIsLoading(true);
        setError(null);

        const maxRetries = 3;
        const retryDelay = 2000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await ApiProxy.request(dsUrl);
                setIsDsRunning(true);

                const podsUrlWithCacheBust = `${podsUrl}&t=${new Date().getTime()}`;
                const podListResponse = await ApiProxy.request(podsUrlWithCacheBust);
                setPods(podListResponse.items || []);

                setIsLoading(false);
                return;

            } catch (err: any) {
                if (err.status === 404) {
                    setIsDsRunning(false);
                    setPods([]);
                    setIsLoading(false);
                    return;
                }

                if (attempt < maxRetries) {
                    console.warn(`Attempt ${attempt} failed, retrying in ${retryDelay / 1000}s...`, err);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    console.error("Failed to check DaemonSet status after multiple retries:", err);
                    setError(`检查抓包工具状态失败: ${err.message || 'Unreachable'}`);
                    setIsLoading(false);
                    return;
                }
            }
        }
    }, [dsUrl, podsUrl]);

    React.useEffect(() => {
        checkDaemonSetStatus();
    }, [checkDaemonSetStatus]);

    const ensureNamespaceExists = async () => {
        try {
            await ApiProxy.request(nsUrl);
        } catch (err: any) {
            if (err.status === 404) {
                console.log(`Namespace ${DS_NAMESPACE} not found, creating it...`);
                try {
                    await ApiProxy.request('/api/v1/namespaces', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            apiVersion: 'v1',
                            kind: 'Namespace',
                            metadata: { name: DS_NAMESPACE },
                        }),
                    });
                } catch (createErr: any) {
                    throw new Error(`创建命名空间 ${DS_NAMESPACE} 失败: ${createErr.message}`);
                }
            } else {
                throw err;
            }
        }
    };

    const handleStartCapture = async () => {
        setIsLoading(true);
        setError(null);
        try {
            await ensureNamespaceExists();
            const dsSpec = getTcpdumpDaemonSetSpec(captureFilter, captureImage);
            await ApiProxy.request(`/apis/apps/v1/namespaces/${DS_NAMESPACE}/daemonsets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dsSpec),
            });
            setTimeout(checkDaemonSetStatus, 2000);
        } catch (err: any) {
            console.error("Failed to start capture:", err);
            setError(`启动抓包失败: ${err.message || '未知错误'}`);
            setIsLoading(false);
        }
    };

    const handleStopCapture = async () => {
        setIsLoading(true);
        setError(null);
        try {
            await ApiProxy.request(dsUrl, { method: 'DELETE' });
            setTimeout(checkDaemonSetStatus, 2000);
        } catch (err: any) {
            console.error("Failed to stop capture:", err);
            setError(`停止抓包失败: ${err.message || '未知错误'}`);
            setIsLoading(false);
        }
    };

    const getBackendNodePort = React.useCallback(async (): Promise<number> => {
        try {
            const service = await K8s.ResourceClasses.Service.apiGet({
                name: BACKEND_SERVICE_NAME,
                namespace: BACKEND_SERVICE_NAMESPACE,
            });

            if (!service || !service.spec || !service.spec.ports || service.spec.ports.length === 0) {
                throw new Error(`Service "${BACKEND_SERVICE_NAME}" has no spec.ports defined.`);
            }

            const portInfo = service.spec.ports[0];
            if (portInfo && portInfo.nodePort) {
                console.log(`Successfully fetched NodePort: ${portInfo.nodePort}`);
                return portInfo.nodePort;
            }

            throw new Error(`Service "${BACKEND_SERVICE_NAME}" found, but it has no nodePort defined.`);
        } catch (err) {
            console.error(`Failed to get backend NodePort service: ${err}`);
            throw new Error(`无法获取后端服务端口: ${err.message || '未知错误'}`);
        }
    }, []);

    const handleStopAndDownload = async () => {
        setIsDownloading(true);
        setError(null);
        setProgress('正在连接后端...');

        const nodeHost = window.location.hostname;
        const nodePort = 31138;
        const wsUrl = `ws://${nodeHost}:${nodePort}/ws`;

        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {

            setProgress('连接成功，正在发送任务...');
            const taskID = "task-" + Date.now();

            const podsToCollect = pods.map(pod => ({
                name: pod.metadata.name,
                nodeName: pod.spec.nodeName,
            }));

            ws.send(JSON.stringify({
                taskID: taskID,
                podsToCollect: podsToCollect,
            }));
        };

        const cleanupFiles = async () => {
            setProgress('正在清理节点上的残留文件...');
            try {
                const cleanupDsSpec = getCleanupDaemonSetSpec(captureImage);
                const cleanupDsUrl = `/apis/apps/v1/namespaces/${DS_NAMESPACE}/daemonsets/${CLEANUP_DS_NAME}`;

                await ApiProxy.post(`/apis/apps/v1/namespaces/${DS_NAMESPACE}/daemonsets`, cleanupDsSpec);
                console.log('Cleanup DaemonSet created.');

                setTimeout(async () => {
                    await ApiProxy.delete(cleanupDsUrl);
                    console.log('Cleanup DaemonSet deleted.');
                    setProgress('清理完成！');
                }, 5000);

            } catch (err: any) {
                console.error('Failed to run cleanup job:', err);
                setProgress('文件已下载，但自动清理失败。');
            }
        };

        ws.onmessage = (event) => {
            const update = JSON.parse(event.data);

            setProgress(update.message);

            if (update.status === 'complete') {
                setProgress('任务完成，正在触发下载...');
                const downloadUrl = `http://${nodeHost}:${nodePort}${update.url}`;
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = `cluster-capture-${new Date().toISOString()}.pcap`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                ws.close();
                cleanupFiles();
                setIsDownloading(false);
                setTimeout(checkDaemonSetStatus, 2000);
            }

            if (update.status === 'error') {
                setError(`后端任务失败: ${update.message}`);
                ws.close();
                setIsDownloading(false);
            }
        };

        ws.onerror = (event) => {
            setError('WebSocket 连接错误');
            console.error('WebSocket error:', event);
            setIsDownloading(false);
        };

        ws.onclose = () => {
            console.log('WebSocket 连接已关闭');
            if (!error && progress !== '任务完成，正在触发下载...') {
                setIsDownloading(false);
            }
        };
    };


    return (
        <Paper sx={{ m: 2, p: 3 }}>
            <Typography variant="h4" gutterBottom>
                集群网络抓包工具
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

            {isDownloading && progress &&
                <Alert severity="info" sx={{ mb: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <CircularProgress size={20} sx={{ mr: 2 }} />
                        <Typography>{progress}</Typography>
                    </Box>
                </Alert>
            }

            <Box sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 4 }}>
                <Typography variant="h6" gutterBottom>控制面板</Typography>
                <Box>
                    <TextField
                        label="抓包镜像"
                        fullWidth
                        variant="outlined"
                        size="small"
                        value={captureImage}
                        onChange={e => setCaptureImage(e.target.value)}
                        disabled={isDsRunning || isLoading}
                        sx={{ mb: 2 }}
                    />
                    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                        <TextField
                            label="抓包过滤规则 (BPF Filter)"
                            variant="outlined"
                            size="small"
                            value={captureFilter}
                            onChange={e => setCaptureFilter(e.target.value)}
                            disabled={isDsRunning || isLoading}
                            sx={{ flexGrow: 1, minWidth: '300px' }}
                        />

                        {!isDsRunning ? (
                            <Button
                                variant="contained"
                                color="primary"
                                onClick={handleStartCapture}
                                disabled={isLoading}
                                startIcon={isLoading && <CircularProgress size={20} color="inherit" />}
                            >
                                {isLoading ? '正在启动...' : '开始抓包'}
                            </Button>
                        ) : (
                            <>
                                <Button
                                    variant="contained"
                                    color="secondary"
                                    onClick={handleStopAndDownload}
                                    disabled={isLoading}
                                    startIcon={isDownloading && <CircularProgress size={20} color="inherit" />}
                                >
                                    {isDownloading ? '正在处理...' : '停止并下载'}
                                </Button>
                                <Button
                                    variant="outlined"
                                    color="error"
                                    onClick={handleStopCapture}
                                    disabled={isLoading}
                                    startIcon={isLoading && !isDownloading && <CircularProgress size={20} color="inherit" />}
                                >
                                    {isLoading && !isDownloading ? '正在停止...' : '仅停止 (不下载)'}
                                </Button>
                            </>
                        )}
                    </Box>
                </Box>
            </Box>

            <Box>
                <Typography variant="h6" gutterBottom>状态</Typography>
                {isLoading && !error && (
                    <Box sx={{ display: 'flex', alignItems: 'center', mt: 2 }}>
                        <CircularProgress size={24} />
                        <Typography sx={{ ml: 2 }}>正在加载状态...</Typography>
                    </Box>
                )}
                {!isLoading && (
                    isDsRunning ? (
                        <>
                            <Alert severity="success" sx={{ mb: 2 }}>
                                抓包正在进行中... DaemonSet '{DS_NAME}' 已在 <strong>{DS_NAMESPACE}</strong> 命名空间部署。
                            </Alert>
                            <Typography variant="subtitle1" gutterBottom>抓包文件说明</Typography>
                            <Alert severity="info" sx={{ mb: 2 }}>
                                新功能: 点击 "停止并下载" 按钮会自动收集所有节点的抓包文件，合并后提供下载，并清理抓包环境。
                            </Alert>
                            <Typography variant="subtitle1" gutterBottom>抓包 Pod 状态</Typography>
                            <TableContainer component={Paper} variant="outlined">
                                <Table size="small">
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Pod 名称</TableCell>
                                            <TableCell>所在节点</TableCell>
                                            <TableCell>状态</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {pods.map(pod => (
                                            <TableRow key={pod.metadata.uid}>
                                                <TableCell>{pod.metadata.name}</TableCell>
                                                <TableCell>{pod.spec.nodeName}</TableCell>
                                                <TableCell>{pod.status.phase}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </>
                    ) : (
                        <Alert severity="info">
                            抓包工具当前未运行。请配置参数后点击 "开始抓包"。
                        </Alert>
                    )
                )}
            </Box>
        </Paper>
    );
}