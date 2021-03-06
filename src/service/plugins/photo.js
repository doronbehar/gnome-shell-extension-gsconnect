'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('Photo'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Photo',
    incomingCapabilities: [
        'kdeconnect.photo',
        'kdeconnect.photo.request'
    ],
    outgoingCapabilities: [
        'kdeconnect.photo',
        'kdeconnect.photo.request'
    ],
    actions: {
        photo: {
            label: _('Photo'),
            icon_name: 'camera-photo-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.photo'],
            outgoing: ['kdeconnect.photo.request']
        }
    }
};


/**
 * Photo Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/photo
 *
 * TODO: use Cheese?
 *       check for /dev/video*
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPhotoPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'photo');

        // A reusable launcher for silence procs
        this._launcher = new Gio.SubprocessLauncher({
            flags: (Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_SILENCE)
        });
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.photo':
                this._receivePhoto(packet);
                break;

            case 'kdeconnect.photo.request':
                this._sendPhoto(packet);
                break;
        }
    }

    /**
     * Ensure we have a directory set for storing files that exists.
     */
    _ensureReceiveDirectory() {
        if (this._receiveDir !== undefined)
            return this._receiveDir;

        // Ensure a directory is set
        this._receiveDir = this.settings.get_string('receive-directory');

        if (this._receiveDir === '') {
            this._receiveDir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_PICTURES
            );

            // Fallback to ~/Pictures
            let homeDir = GLib.get_home_dir();

            if (!this._receiveDir || this._receiveDir === homeDir) {
                this._receiveDir = GLib.build_filenamev([homeDir, 'Pictures']);
                this.settings.set_string('receive-directory', this._receiveDir);
            }
        }

        // Ensure the directory exists
        if (!GLib.file_test(this._receiveDir, GLib.FileTest.IS_DIR))
            GLib.mkdir_with_parents(this._receiveDir, 448);

        return this._receiveDir;
    }

    /**
     * Get a GFile for @filename, while ensuring the directory exists and the
     * file is unique.
     *
     * @param {string} filename - A filename (eg. `image.jpg`)
     * @return {Gio.File} a file object
     */
    _getFile(filename) {
        let dirpath = this._ensureReceiveDirectory();
        let basepath = GLib.build_filenamev([dirpath, filename]);
        let filepath = basepath;
        let copyNum = 0;

        while (GLib.file_test(filepath, GLib.FileTest.EXISTS))
            filepath = `${basepath} (${++copyNum})`;

        return Gio.File.new_for_path(filepath);
    }

    /**
     * Receive a photo taken by the remote device.
     *
     * @param {Core.Packet} packet - a `kdeconnect.photo`
     */
    async _receivePhoto(packet) {
        try {
            // Remote device cancelled the photo operation
            if (packet.body.hasOwnProperty('cancel'))
                return;

            // Open the target path and create a transfer
            let file = this._getFile(packet.body.filename);

            let stream = await new Promise((resolve, reject) => {
                file.replace_async(null, false, 0, 0, null, (file, res) => {
                    try {
                        resolve(file.replace_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            let transfer = this.device.createTransfer(Object.assign({
                output_stream: stream,
                size: packet.payloadSize
            }, packet.payloadTransferInfo));

            // Open the photo if successful, delete on failure
            let success = await transfer.download();

            if (!success) {
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                return;
            }

            let uri = file.get_uri();
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Take a photo using the Webcam and return the path.
     *
     * @param {Core.Packet} packet - A `kdeconnect.photo.request`
     * @return {Promise<string>} A file path
     */
    _takePhoto(packet) {
        return new Promise((resolve, reject) => {
            let time = GLib.DateTime.new_now_local().format('%T');
            let path = GLib.build_filenamev([GLib.get_tmp_dir(), `${time}.jpg`]);
            let proc = this._launcher.spawnv([
                gsconnect.metadata.bin.ffmpeg,
                '-f', 'video4linux2',
                '-ss', '0:0:2',
                '-i', '/dev/video0',
                '-frames', '1',
                path
            ]);

            proc.wait_check_async(null, (proc, res) => {
                try {
                    proc.wait_check_finish(res);
                    resolve(path);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Send a photo to the remote device.
     *
     * @param {Core.Packet} packet - A `kdeconnect.photo.request`
     */
    async _sendPhoto(packet) {
        if (this.settings.get_boolean('share-camera'))
            return;

        try {
            let file = null;
            let path = await this._takePhoto();

            if (path.startsWith('file://'))
                file = Gio.File.new_for_uri(path);
            else
                file = Gio.File.new_for_path(path);

            // Prepare the file for upload
            let stream = new Promise((resolve, reject) => {
                file.read_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                    try {
                        resolve(file.read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            let info = new Promise((resolve, reject) => {
                file.query_info_async(
                    'standard::size',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (file, res) => {
                        try {
                            resolve(file.query_info_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            await Promise.all([stream, info]);

            // Transfer
            let transfer = this.device.createTransfer({
                input_stream: stream,
                size: info.get_size()
            });

            let success = await transfer.upload({
                type: 'kdeconnect.photo',
                body: {
                    filename: file.get_basename()
                }
            });

            if (!success) {
                this.device.showNotification({
                    id: transfer.uuid,
                    title: _('Transfer Failed'),
                    // TRANSLATORS: eg. Failed to send "photo.jpg" to Google Pixel
                    body: _('Failed to send “%s” to %s').format(
                        file.get_basename(),
                        this.device.name
                    ),
                    icon: new Gio.ThemedIcon({name: 'dialog-warning-symbolic'})
                });
            }
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Request the remote device begin a photo operation.
     */
    photo() {
        this.device.sendPacket({
            type: 'kdeconnect.photo.request',
            body: {}
        });
    }
});

