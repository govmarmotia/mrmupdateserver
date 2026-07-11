#!/bin/bash

# ==============================================================================
# WIZARD DI INSTALLAZIONE GRAFICO PER MRMSUITE UPDATE SERVER (UBUNTU)
# Supporta Zenity (Desktop GUI) e Whiptail (Terminal GUI)
# ==============================================================================

# Verifica permessi di root
if [ "$EUID" -ne 0 ]; then
  echo "Usa 'sudo ./install.sh' per eseguire l'installazione."
  exit 1
fi

# Rileva se è disponibile una sessione grafica Desktop con Zenity
USE_GUI=0
if command -v zenity >/dev/null 2>&1 && [ -n "$DISPLAY" ]; then
  USE_GUI=1
fi

# Funzioni helper per mostrare dialoghi grafici o testuali
show_error() {
  local title="$1"
  local msg="$2"
  if [ $USE_GUI -eq 1 ]; then
    zenity --error --title="$title" --text="$msg" --width=450
  else
    whiptail --title "$title" --msgbox "$msg" 10 60
  fi
}

show_info() {
  local title="$1"
  local msg="$2"
  if [ $USE_GUI -eq 1 ]; then
    zenity --info --title="$title" --text="$msg" --width=450
  else
    whiptail --title "$title" --msgbox "$msg" 10 60
  fi
}

show_progress() {
  local title="$1"
  local msg="$2"
  if [ $USE_GUI -eq 1 ]; then
    # Ritorna un pipe per zenity progress
    zenity --progress --title="$title" --text="$msg" --percentage=0 --auto-close --width=450
  else
    # Whiptail progress bar finta (ritorna wrapper standard)
    echo "progress"
  fi
}

# 1. VERIFICA PRESENZA NETBIRD
if ! command -v netbird >/dev/null 2>&1; then
  show_error "Errore Netbird Mancante" "Netbird NON è installato su questa macchina Ubuntu! Per favore, scarica e configura Netbird prima di installare il server degli aggiornamenti (necessario per abilitare l'accessibilità privata sicura dei Launcher)."
  exit 1
fi

# Verifica se il servizio Netbird è attivo
NETBIRD_STATUS=$(systemctl is-active netbird 2>/dev/null)
if [ "$NETBIRD_STATUS" != "active" ]; then
  show_error "Errore Servizio Netbird" "Netbird risulta installato, ma il servizio NON è attivo. Esegui 'sudo systemctl start netbird' ed effettua il login prima di procedere."
  exit 1
fi

# 2. BENVENUTO E INTRODUZIONE
if [ $USE_GUI -eq 1 ]; then
  zenity --question --title="MRMSuite Update Server Setup" --text="Benvenuto nel Wizard di Installazione di MRMSuite Update Server.\n\nQuesto programma installerà il server degli aggiornamenti e configurerà le dipendenze di sistema automaticamente.\n\nVuoi procedere?" --width=450
  if [ $? -ne 0 ]; then
    exit 0
  fi
else
  whiptail --title "MRMSuite Update Server Setup" --yesno "Benvenuto nel Wizard di Installazione di MRMSuite Update Server.\n\nQuesto programma installerà il server degli aggiornamenti e configurerà le dipendenze di sistema automaticamente.\n\nVuoi procedere?" 12 60
  if [ $? -ne 0 ]; then
    exit 0
  fi
fi

# 3. INSTALLAZIONE DIPENDENZE (NODEJS & NPM)
# Avvio di un'installazione sequenziale e monitoraggio
if [ $USE_GUI -eq 1 ]; then
  (
    echo "10" ; echo "# Aggiornamento repository APT..."
    apt-get update -y >/dev/null 2>&1
    
    echo "40" ; echo "# Controllo ed installazione di Node.js..."
    if ! command -v node >/dev/null 2>&1; then
      # Installa Node.js LTS
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
      apt-get install -y nodejs >/dev/null 2>&1
    fi
    
    echo "70" ; echo "# Installazione di NPM..."
    if ! command -v npm >/dev/null 2>&1; then
      apt-get install -y npm >/dev/null 2>&1
    fi
    
    echo "100" ; echo "# Dipendenze di sistema pronte!"
  ) | zenity --progress --title="Installazione Dipendenze" --text="Inizializzazione..." --percentage=0 --auto-close --width=450
else
  echo "Aggiornamento repository APT..."
  apt-get update -y >/dev/null 2>&1
  if ! command -v node >/dev/null 2>&1; then
    echo "Installazione Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "Installazione NPM..."
    apt-get install -y npm >/dev/null 2>&1
  fi
fi

# 4. CONFIGURAZIONE APPLICAZIONE
INSTALL_DIR="/opt/mrmsuite-update-server"
if [ $USE_GUI -eq 1 ]; then
  (
    echo "20" ; echo "# Copia dei file in $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    cp -r * "$INSTALL_DIR/" 2>/dev/null
    
    echo "50" ; echo "# Configurazione del progetto (NPM install)..."
    cd "$INSTALL_DIR"
    npm install --omit=dev >/dev/null 2>&1
    
    echo "100" ; echo "# File pronti!"
  ) | zenity --progress --title="Configurazione File" --text="Configurazione dell'applicazione..." --percentage=0 --auto-close --width=450
else
  echo "Copia dei file in $INSTALL_DIR..."
  mkdir -p "$INSTALL_DIR"
  cp -r * "$INSTALL_DIR/" 2>/dev/null
  echo "Configurazione del progetto (NPM install)..."
  cd "$INSTALL_DIR"
  npm install --omit=dev >/dev/null 2>&1
fi

# 5. CONFIGURAZIONE DEL SERVIZIO SYSTEMD
if [ $USE_GUI -eq 1 ]; then
  (
    echo "20" ; echo "# Configurazione di systemd..."
    cp "$INSTALL_DIR/mrm-update-server.service" /etc/systemd/system/ 2>/dev/null
    
    echo "50" ; echo "# Abilitazione all'avvio..."
    systemctl daemon-reload
    systemctl enable mrm-update-server >/dev/null 2>&1
    
    echo "80" ; echo "# Avvio del servizio..."
    systemctl start mrm-update-server
    
    echo "100" ; echo "# Servizio avviato!"
  ) | zenity --progress --title="Abilitazione Servizio" --text="Configurazione del servizio systemd..." --percentage=0 --auto-close --width=450
else
  echo "Configurazione di systemd..."
  cp "$INSTALL_DIR/mrm-update-server.service" /etc/systemd/system/ 2>/dev/null
  systemctl daemon-reload
  systemctl enable mrm-update-server >/dev/null 2>&1
  echo "Avvio del servizio..."
  systemctl start mrm-update-server
fi

# 6. SCHERMATA FINALE SUCCESS
# Recupera l'IP della VPN Netbird
NETBIRD_IP=$(ip -4 addr show dev wt0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}')
if [ -z "$NETBIRD_IP" ]; then
  NETBIRD_IP=$(ip addr | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -n 1)
fi

SUCCESS_MSG="L'installazione di MRMSuite Update Server è completata con successo!\n\nIl server è attivo e in esecuzione come servizio di sistema.\n\nAccedi alla Dashboard degli aggiornamenti tramite questo link:\n--> http://${NETBIRD_IP}:3000"
show_info "Installazione Completata!" "$SUCCESS_MSG"

echo "=================================================="
echo "INSTALLAZIONE COMPLETATA CON SUCCESSO!"
echo "Accedi alla dashboard degli aggiornamenti: http://${NETBIRD_IP}:3000"
echo "=================================================="
