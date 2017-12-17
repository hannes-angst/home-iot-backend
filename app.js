// Load the http module to create an http server.
var express = require('express')
    , app = express()
    , http = require('http')
    , io = require('socket.io')
    , mqtt = require('mqtt')
    , cors = require('cors')
    , harmonyCli = require('harmonyhubjs-client')
    , conf = require('./config.json')
    , fs = require('fs');


function save() {
    fs.writeFile('./config.json', JSON.stringify(conf, null, 2), function (err) {
        if (err) {
            console.log('There has been an error saving your configuration data.');
            console.log(err.message);
            return;
        }
        console.log('Configuration saved successfully.')
    });
}


var server = http.createServer(function (req, res) {
    if (req.method === 'GET') {
        res.writeHead(200, {'Content-Type': '*/*', 'Access-Control-Allow-Origin': '*'});
        res.end(JSON.stringify(
            {
                "devices": conf.devices,
                "harmony": conf.harmony
            }
        ));
    }
    else {
        res.writeHead(405, {'Content-Type': '*/*', 'Access-Control-Allow-Origin': '*'});
        res.end("");
    }
});

var webSocket = io.listen(server);
const client = mqtt.connect(conf.mqtt.url);


app.use(cors());


webSocket.heartbeatTimeout = 20000;


var harmonyClientHack = null;


function setActivity(activityId) {
    if (activityId === -1) {
        conf.harmony.status = 'off';
    } else {
        conf.harmony.status = 'on';
    }
    for (var idx = 0; idx < conf.harmony.activities.length; idx++) {
        conf.harmony.activities[idx].selected = conf.harmony.activities[idx] === activityId;
    }
}

harmonyCli(conf.harmony.url)
    .then(function (harmonyClient) {
        console.log("Connected to harmony.");
        harmonyClientHack = harmonyClient;

        harmonyClient.on("stateDigest", function (stateDigest) {
            var changed = false;
            try {
                console.log(JSON.stringify(stateDigest, null, 2));
            } catch (error) {
                console.log("StateDigest stringification failed. " + error);
            }
            if (stateDigest && stateDigest.errorCode === "200") {
                if ( //0 = hub is off, 3 = hub shutdown of
                stateDigest.activityStatus === 0 || stateDigest.activityStatus === 3) {
                    setActivity(-1);
                    changed = true;
                } else if (// 1 = Activity is starting, 2 = Activity is started
                    stateDigest.activityStatus === 1 || stateDigest.activityStatus === 2) {
                    setActivity(stateDigest.activityId);
                    changed = true;
                }
            }
            if (changed) {
                save();
                webSocket.emit('harmony', conf.harmony);
            }
        });

        harmonyClient
            .isOff()
            .then(function (off) {
                if (off) {
                    conf.harmony.status = "off";
                } else {
                    conf.harmony.status = "on";
                }
            });

        harmonyClient
            .getCurrentActivity()
            .then(function (activityId) {
                var selected = activityId;
                harmonyClient
                    .getActivities()
                    .then(function (activities) {
                        conf.harmony.activities = [];
                        for (var idx = 0; idx < activities.length; idx++) {
                            var activity = activities[idx];
                            if (activity.id === -1) {
                                console.log("Power");
                                conf.harmony.power = {
                                    "id": activity.id,
                                    "label": activity.label
                                };
                            } else {
                                console.log("Activity: " + activity.label);
                                conf.harmony.activities.push({
                                    "id": activity.id,
                                    "label": activity.label,
                                    "selected": selected === activity.id
                                });
                            }
                        }
                        save();
                    });
            });
    })
;


webSocket.on('connection', function (socket) {
    // emitted after handshake
    console.log("connect: " + socket.id);
    socket.on('mqtt', function (data) {
        client.publish(data.topic, data.body, function (err) {
            if (err) {
                console.log("Publishing " + data.topic + " failed: " + err);
            } else {
                console.log("Publishing " + data.topic + " succeeded.");
            }
        });
    });
    socket.on('activity', function (data) {
        console.log("Received activity set [" + JSON.stringify(data) + "].");
        try {
            harmonyClientHack.startActivity(data.activityId);
        } catch (error) {
            console.log("Could not start activity. " + error);
        }
    });
    socket.on('powerOff', function (data) {
        console.log("Received power off.");
        try {
            harmonyClientHack.turnOff();
        } catch (error) {
            console.log("Could not start activity. " + error);
        }
    });


    socket.emit('dump', conf.devices);
    socket.emit('harmony', conf.harmony);
});


client.on('connect', function () { // When connected
    console.log("MQTT connected.");
    var sub;
    for (var i = 0; i < conf.devices.length; i++) {
        var device = conf.devices[i];
        if (device.type === 'switch') {
            sub = "/info";
            console.log("Subscribing to: %s", device.baseURL + sub);
            client.subscribe(device.baseURL + sub);
            sub = "/switch";
            console.log("Subscribing to: %s", device.baseURL + sub);
            client.subscribe(device.baseURL + sub);
        } else if (device.type === 'relay') {
            sub = "/info";
            console.log("Subscribing to: %s", device.baseURL + sub);
            client.subscribe(device.baseURL + sub);
            sub = "/switch/+";
            console.log("Subscribing to: %s", device.baseURL + sub);
            client.subscribe(device.baseURL + sub);
        } else if (device.type === 'environment') {
            sub = "/env";
            console.log("Subscribing to: %s", device.baseURL + sub);
            client.subscribe(device.baseURL + sub);
        }
    }

    console.log("Sending sending discovery");
    client.publish('/angst/devices/discovery/');
});


client.on('message', function (topic, message) {
    var info;
    for (var i = 0; i < conf.devices.length; i++) {
        var device = conf.devices[i];
        if (topic.startsWith(device.baseURL)) {
            if (device.type === 'environment') {
                if (topic.endsWith("/env")) {
                    try {
                        console.log('matching topic %s to temperature %s status = %s', topic, device.name, device.status);
                        info = JSON.parse(message);
                        device.status = info.status;
                        device.last = new Date().getTime();
                        if (info.status === 'OK') {
                            device.temperature = info.temperature;
                            device.humidity = info.humidity;
                            device.lastSuccess = new Date().getTime();
                        }
                        save();
                        webSocket.sockets.emit('data', device);
                    } catch (error) {
                        console.log(error);
                        console.log('Error parsing message "%s" of topic "%s"', message, topic);
                    }
                    return;
                }
            } else if (device.type === 'relay') {
                if (topic.indexOf("/switch/") !== -1) {
                    try {
                        var arr = topic.split('/');
                        var number = parseInt(arr[arr.length - 1]);
                        if (number > 0 && number < 9) {
                            //get relay no from topic
                            info = JSON.parse(message);
                            device.states[number - 1] = info.state;

                            console.log('matching topic %s to relay %s switch %d status = %s', topic, device.name, number, device.states);
                            webSocket.sockets.emit('data', device);
                            save();
                        } else {
                            console.log('Invalid number: %d ("%s") [raw: %s]', number, arr[arr.length - 1], arr);

                        }
                    } catch (error) {
                        console.log(error);
                        console.log('Error parsing message "%s" of topic "%s"', message, topic);
                    }
                    return;
                } else if (topic.endsWith("/info")) {
                    try {
                        info = JSON.parse(message);
                        for (var attrname in info) {
                            device[attrname] = info[attrname];
                        }
                        console.log('matching topic %s to relay %s data: %s', topic, device.name, message);
                        webSocket.sockets.emit('data', device);
                        save();
                    } catch (error) {
                        console.log(error);
                        console.log('Error parsing message "%s" of topic "%s"', message, topic);
                    }
                    return;
                }
            } else if (device.type === 'switch') {
                if (topic.endsWith("/switch")) {
                    try {
                        info = JSON.parse(message);
                        device.status = info.state;

                        if (device.status === 'on') {
                            device.onTime = new Date().getTime();
                        }
                        if (device.status === 'off') {
                            device.offTime = new Date().getTime();
                        }

                        console.log('matching topic %s to switch (state) %s switch status = %s', topic, device.name, device.status);
                        webSocket.sockets.emit('data', device);
                        save();
                    } catch (error) {
                        console.log(error);
                        console.log('Error parsing message "%s" of topic "%s"', message, topic);
                    }
                    return;
                } else if (topic.endsWith("/info")) {
                    try {
                        info = JSON.parse(message);
                        device.status = info.switch;
                        console.log('matching topic %s to switch (state) %s switch status = %s', topic, device.name, device.status);
                        webSocket.sockets.emit('data', device);
                        save();
                    } catch (error) {
                        console.log(error);
                        console.log('Error parsing message "%s" of topic "%s"', message, topic);
                    }
                    return;
                }
            }
        }
    }
    console.log('No handler for topic %s', topic)
});


server.listen(conf.port);


// Put a friendly message on the terminal
console.log("Server running at " + conf.port);

