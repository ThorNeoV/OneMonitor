// Register extra column and filter for device table
if (window.MeshCentralShell) {
  MeshCentralShell.AddDeviceColumn({
    id: 'onedriveCheck',
    name: 'OneDrive Status',
    get: function(device) {
      if (device.onedriveCheck) {
        return device.onedriveCheck.status;
      }
      return '-';
    },
    sort: function(a, b) {
      // Sort by status string
      return (a.onedriveCheck?.status || '').localeCompare(b.onedriveCheck?.status || '');
    },
    filter: [
      { value: 'App Online', name: 'App Online' },
      { value: 'Not signed in', name: 'Not signed in' },
      { value: 'Offline', name: 'Offline' }
    ]
  });
}