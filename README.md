# OneMonitor
Checks ports for Servers via MashCentral
docker exec -it meshcentral-meshcentral-1 sh
cd /opt/meshcentral/meshcentral-data
rm -rf plugins/onedrivecheck
rm -f pluginsettings.json installedPlugins.json mesherrors.txt
exit
docker restart meshcentral-meshcentral-1
docker logs -f meshcentral-meshcentral-1
