import React from 'react';
import {
    Box, Button, CircularProgress, Paper, TextField, Typography, Alert,
    Table, TableBody, TableCell, TableContainer, TableHead, TableRow
} from '@mui/material';
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';

const DS_NAME = 'tcpdump-capture-ds';
const DS_NAMESPACE = 'kubexm-capture';
const DS_LABEL_SELECTOR = 'app=tcpdump-capture';

function getTcpdumpDaemonSetSpec(filter: string, image: string) {
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

import { K8s } from '@kinvolk/headlamp-plugin/lib';
type K8sPod = InstanceType<typeof K8s.ResourceClasses.Pod>;

export default function TcpdumpCapturePage() {
    const [isDsRunning, setIsDsRunning] = React.useState<boolean>(false);
    const [isLoading, setIsLoading] = React.useState<boolean>(true);
    const [error, setError] = React.useState<string | null>(null);

    const [captureFilter, setCaptureFilter] = React.useState(''); //tcp port 80 or tcp port 443
    const [captureImage, setCaptureImage] = React.useState('registry.dev.rdev.tech:18093/headlamp/super-netshoot:2.0');

    const [pods, setPods] = React.useState<K8sPod[]>([]);

    const dsUrl = `/apis/apps/v1/namespaces/${DS_NAMESPACE}/daemonsets/${DS_NAME}`;
    const nsUrl = `/api/v1/namespaces/${DS_NAMESPACE}`;
    const podsUrl = `/api/v1/namespaces/${DS_NAMESPACE}/pods?labelSelector=${DS_LABEL_SELECTOR}`;

    const checkDaemonSetStatus = React.useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            await ApiProxy.request(dsUrl);
            setIsDsRunning(true);
            const podList = await ApiProxy.request(podsUrl);
            setPods(podList.items || []);
        } catch (err: any) {
            if (err.status === 404) {
                setIsDsRunning(false);
                setPods([]);
            } else {
                console.error("Failed to check DaemonSet status:", err);
                setError(`检查抓包工具状态失败: ${err.message || '未知错误'}`);
            }
        } finally {
            setIsLoading(false);
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

    return (
        <Paper sx={{ m: 2, p: 3 }}>
            <Typography variant="h4" gutterBottom>
                集群网络抓包工具
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

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
                        <Button
                            variant="contained"
                            color={isDsRunning ? "error" : "primary"}
                            onClick={isDsRunning ? handleStopCapture : handleStartCapture}
                            disabled={isLoading}
                            startIcon={isLoading && <CircularProgress size={20} color="inherit" />}
                        >
                            {isLoading ? (isDsRunning ? '正在停止...' : '正在启动...') : (isDsRunning ? '停止抓包' : '开始抓包')}
                        </Button>
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
                                抓包文件 (.pcap) 被保存在 **每个节点** 的 <strong>/tmp/captures/</strong> 目录下。
                                <br />
                                文件名格式为: <strong>[节点名称].pcap</strong>。
                                <br />
                                您需要通过 SSH 或 `kubectl cp` 登录到相应节点以获取文件。
                                例如: `kubectl cp {DS_NAMESPACE}/[Pod名称] /captures/[节点名称].pcap ./[节点名称].pcap`
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