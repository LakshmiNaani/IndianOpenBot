package org.openbot.env;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Size;
import android.view.SurfaceView;
import android.view.TextureView;
import androidx.core.content.ContextCompat;
import com.pedro.rtplibrary.view.OpenGlView;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.openbot.utils.AndGate;
import org.openbot.utils.ConnectionUtils;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.Camera1Enumerator;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraEnumerator;
import org.webrtc.CameraVideoCapturer;
import org.webrtc.CandidatePairChangeEvent;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoDecoderFactory;
import org.webrtc.VideoEncoderFactory;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import timber.log.Timber;

/*
This class initiates a WebRTC call to the controller, by sending an WebRTC "offer"
to the controller, providing its A/V capabilities. It then waits for an "answer" with
controller's capabilities. The two sides then exchange ICE candidates until a suitable
common capabilities are found, and then media is streamed from this class to the controller.

Note that the media is streamed only one way from this class to the controller.

WebRTC does not specify signaling protocol. Usually, a separate signaling server is used
witch mediates between the two WebRTC peers, and communication from and to this server is
carried over WebSocket. However, we already have a communication channel between the peers
(NetworkServiceConnection) so we are using it instead. No separate signaling server is required.

It is possible in the future to factor out signaling into a separate class and provide
various signalling types, such as to separate signalling server.
 */
public class WebRtcServer implements IVideoServer {
  private final String TAG = "WebRtcPeer";
  private SurfaceViewRenderer view;
  private Size resolution = new Size(640, 360);

  // Endpoint that mints short-lived TURN credentials, matching
  // VITE_PUBLIC_ICE_SERVERS_URL in the web controller. Required whenever the robot
  // and the controller are on different networks. Empty means STUN only.
  private static final String ICE_SERVERS_URL = "https://indianbot-turn.sbayreddy.workers.dev";
  private static final String FALLBACK_STUN_SERVER = "stun:stun.l.google.com:19302";

  private volatile ArrayList<PeerConnection.IceServer> cachedIceServers = null;

  public static final String VIDEO_TRACK_ID = "ARDAMSv0";
  public static final int VIDEO_RESOLUTION_WIDTH = 640;
  public static final int VIDEO_RESOLUTION_HEIGHT = 360;
  public static final int FPS = 30;

  // WebRTC-specific
  private EglBase rootEglBase;
  private PeerConnectionFactory factory;
  private VideoTrack videoTrackFromCamera;
  MediaConstraints audioConstraints;
  AudioSource audioSource;
  AudioTrack localAudioTrack;
  SurfaceTextureHelper surfaceTextureHelper;
  private PeerConnection peerConnection;
  private RtpSender videoSender;
  private RtpSender audioSender;
  private VideoTrack remoteVideoTrack;
  private AudioTrack remoteAudioTrack;
  // Which feed is currently rendered on this phone's own screen. The
  // controller's webcam is the default (see showControllerVideo()); this only
  // tracks the LOCAL display choice and has no effect on what is streamed out.
  private boolean displayingRobotCamera = false;

  private AndGate andGate;
  private Context context;
  private VideoCapturer videoCapturer;

  private final SignalingHandler signalingHandler = new SignalingHandler();

  public WebRtcServer() {}

  // IVideoServer Interface
  @Override
  public void init(Context context) {
    this.context = context;

    andGate = new AndGate(() -> startServer(), () -> stopServer());
    andGate.addCondition("connected");
    andGate.addCondition("view set");
    andGate.addCondition("camera permission");
    andGate.addCondition("resolution set");
    andGate.addCondition("can start");

    int camera = ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA);
    andGate.set("camera permission", camera == PackageManager.PERMISSION_GRANTED);

    rootEglBase = EglBase.create();

    // Fetched up front so the network call is never on the startServer() path,
    // which may run on the main thread when the last AndGate condition is met.
    prefetchIceServers();

    signalingHandler.handleControllerWebRtcEvents();
  }

  /**
   * Fetches TURN credentials in the background and caches them for
   * createPeerConnection(). Failures are logged and leave the cache empty, which
   * degrades to STUN rather than blocking video from starting.
   */
  private void prefetchIceServers() {
    if (ICE_SERVERS_URL.isEmpty()) {
      Log.w(TAG, "ICE_SERVERS_URL is not set, remote connections will likely fail");
      return;
    }

    new Thread(
            () -> {
              HttpURLConnection httpConnection = null;
              try {
                URL url = new URL(ICE_SERVERS_URL);
                httpConnection = (HttpURLConnection) url.openConnection();
                httpConnection.setConnectTimeout(10000);
                httpConnection.setReadTimeout(10000);

                int status = httpConnection.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) {
                  Log.e(TAG, "ICE server request failed with status " + status);
                  return;
                }

                StringBuilder response = new StringBuilder();
                try (BufferedReader reader =
                    new BufferedReader(new InputStreamReader(httpConnection.getInputStream()))) {
                  String line;
                  while ((line = reader.readLine()) != null) {
                    response.append(line);
                  }
                }

                cachedIceServers = parseIceServers(new JSONObject(response.toString()));
                Log.d(TAG, "Fetched " + cachedIceServers.size() + " ICE servers");
              } catch (IOException | JSONException e) {
                Log.e(TAG, "Could not fetch ICE servers: " + e);
              } finally {
                if (httpConnection != null) {
                  httpConnection.disconnect();
                }
              }
            })
        .start();
  }

  /**
   * Converts the endpoint's {"iceServers": [{urls, username, credential}, ...]}
   * payload into WebRTC IceServer objects. "urls" may be a string or an array.
   */
  private ArrayList<PeerConnection.IceServer> parseIceServers(JSONObject body)
      throws JSONException {
    ArrayList<PeerConnection.IceServer> iceServers = new ArrayList<>();
    JSONArray servers = body.getJSONArray("iceServers");

    for (int i = 0; i < servers.length(); i++) {
      JSONObject server = servers.getJSONObject(i);

      ArrayList<String> urls = new ArrayList<>();
      Object rawUrls = server.get("urls");
      if (rawUrls instanceof JSONArray) {
        JSONArray urlArray = (JSONArray) rawUrls;
        for (int j = 0; j < urlArray.length(); j++) {
          urls.add(urlArray.getString(j));
        }
      } else {
        urls.add(rawUrls.toString());
      }

      PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(urls);
      if (server.has("username") && server.has("credential")) {
        builder.setUsername(server.getString("username"));
        builder.setPassword(server.getString("credential"));
      }
      iceServers.add(builder.createIceServer());
    }

    return iceServers;
  }

  @Override
  public boolean isRunning() {
    return false;
  }

  @Override
  public void setCanStart(boolean canStart) {
    andGate.set("can start", canStart);
  }

  @Override
  public void startClient() {
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("VIDEO_PROTOCOL", "WEBRTC"));
    sendServerUrl();
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("VIDEO_COMMAND", "START"));
  }

  @Override
  public void sendServerUrl() {
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("VIDEO_SERVER_URL", ""));
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("FRAGMENT_TYPE", ""));
  }

  @Override
  public void sendVideoStoppedStatus() {
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("VIDEO_COMMAND", "STOP"));
  }

  @Override
  public void setView(SurfaceView view) {}

  @Override
  public void setView(TextureView view) {}

  @Override
  public void setView(SurfaceViewRenderer view) {
    this.view = view;
    this.view.setEnabled(false);
    andGate.set("view set", true);
  }

  @Override
  public void setView(OpenGlView view) {}

  @Override
  public void setConnected(boolean connected) {
    andGate.set("connected", connected);

    int camera = ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA);
    andGate.set("camera permission", camera == PackageManager.PERMISSION_GRANTED);
  }

  @Override
  public void setResolution(int w, int h) {
    resolution = new Size(w, h);
    andGate.set("resolution set", true);
  }
  // end Interface

  // local methods
  private void startServer() {

    initializeSurfaceViews();
    initializePeerConnectionFactory();
    createVideoTrackFromCameraAndShowIt();
    initializePeerConnections();

    startStreamingVideo();
    doCall();
    startClient();
    monitorCameraControlEvents();
  }

  private void monitorCameraControlEvents() {
    ControllerToBotEventBus.subscribe(
        this.getClass().getSimpleName(),
        event -> {
          switch (event.getString("command")) {
            case "SWITCH_CAMERA":
              ((CameraVideoCapturer) videoCapturer).switchCamera(null);
              break;
          }
        },
        error -> {
          Log.d(null, "Error occurred in monitorCameraControlEvents: " + error);
        },
        event ->
            event.has("command")
                && ("SWITCH_CAMERA".equals(event.getString("command"))) // filter everything else
        );
  }

  private void doAnswer() {
    peerConnection.createAnswer(
        new SimpleSdpObserver() {
          @Override
          public void onCreateSuccess(SessionDescription sessionDescription) {
            peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
            JSONObject message = new JSONObject();
            try {
              message.put("type", "answer");
              message.put("sdp", sessionDescription.description);
              sendMessage(message);
            } catch (JSONException e) {
              e.printStackTrace();
            }
          }
        },
        new MediaConstraints());
  }

  private void startStreamingVideo() {
    // addStream()/MediaStream are Plan B-only; Unified Plan requires addTrack().
    // addTrack() creates one transceiver per track, grouped under the given
    // stream id so the controller sees them as one MediaStream on its end.
    List<String> streamIds = Collections.singletonList("ARDAMS");
    videoSender = peerConnection.addTrack(videoTrackFromCamera, streamIds);
    audioSender = peerConnection.addTrack(localAudioTrack, streamIds);

    // addTrack() alone leaves these transceivers at their default direction,
    // which on some libwebrtc versions negotiates as sendonly. The controller
    // needs to send its own webcam/mic back on these same m-lines, so both must
    // explicitly allow receiving too. Must happen before doCall() builds the
    // offer, since the offer's direction is what caps what the answer can do.
    for (RtpTransceiver transceiver : peerConnection.getTransceivers()) {
      RtpSender sender = transceiver.getSender();
      if (sender != null && sender.track() != null) {
        transceiver.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
      }
    }
  }

  private void stopStreamingVideo() {
    if (videoSender != null) {
      peerConnection.removeTrack(videoSender);
    }
    if (audioSender != null) {
      peerConnection.removeTrack(audioSender);
    }
  }

  /**
   * Default local display once a controller connects: the operator's webcam,
   * filling this phone's screen. Runs on the WebRTC signaling thread (this is
   * called from PeerConnection.Observer callbacks), so the actual View work is
   * posted to the main thread.
   */
  private void showControllerVideo() {
    if (remoteVideoTrack == null || view == null) {
      return;
    }
    new Handler(Looper.getMainLooper())
        .post(
            () -> {
              if (displayingRobotCamera) {
                videoTrackFromCamera.removeSink(view);
                displayingRobotCamera = false;
              }
              remoteVideoTrack.addSink(view);
              view.setAlpha(1f);
              view.bringToFront();
            });
  }

  /**
   * Switches the local display to the robot's own camera - e.g. so a bystander
   * next to the robot can confirm what it sees. Does not affect what is
   * streamed to the controller, which always carries the robot's own camera.
   */
  private void showRobotCamera() {
    if (view == null) {
      return;
    }
    new Handler(Looper.getMainLooper())
        .post(
            () -> {
              if (remoteVideoTrack != null) {
                remoteVideoTrack.removeSink(view);
              }
              videoTrackFromCamera.addSink(view);
              displayingRobotCamera = true;
              view.setAlpha(1f);
              view.bringToFront();
            });
  }

  /** No controller connected: nothing useful to show, so go back to hidden. */
  private void hideVideoView() {
    if (view == null) {
      return;
    }
    new Handler(Looper.getMainLooper()).post(() -> view.setAlpha(0f));
  }

  /** Flips which feed is shown locally. Wired to a UI toggle in PhoneController. */
  public void toggleVideoSource() {
    if (displayingRobotCamera) {
      showControllerVideo();
    } else {
      showRobotCamera();
    }
  }

  private void stopServer() {
    stopStreamingVideo();
    remoteVideoTrack = null;
    remoteAudioTrack = null;
    displayingRobotCamera = false;
    view.release();
    stopClient();
  }

  private void stopClient() {
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("VIDEO_COMMAND", "STOP"));
  }

  private void doCall() {
    // No OfferToReceiveAudio/Video constraints here: under Unified Plan
    // libwebrtc still honors those legacy flags by force-downgrading the
    // offered transceiver direction (to sendonly) regardless of the explicit
    // SEND_RECV set in startStreamingVideo(), which caps every answer at
    // recvonly and blocks the controller's webcam/mic from ever being received.
    MediaConstraints sdpMediaConstraints = new MediaConstraints();

    peerConnection.createOffer(
        new SimpleSdpObserver() {
          @Override
          public void onCreateSuccess(SessionDescription sessionDescription) {
            peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
            Log.i(TAG, "Local offer " + sessionDescription.description);
            JSONObject message = new JSONObject();
            try {
              message.put("type", "offer");
              message.put("sdp", sessionDescription.description);

              sendMessage(message);
            } catch (JSONException e) {
              e.printStackTrace();
            }
          }
        },
        sdpMediaConstraints);
  }

  private void initializePeerConnections() {
    peerConnection = createPeerConnection(factory);
  }

  private PeerConnection createPeerConnection(PeerConnectionFactory factory) {
    ArrayList<PeerConnection.IceServer> iceServers = cachedIceServers;

    if (iceServers == null) {
      // Prefetch has not finished, or the endpoint is unreachable. STUN alone only
      // works when the controller is on the same network or behind a friendly NAT.
      Log.w(TAG, "No TURN credentials available, falling back to STUN only");
      iceServers = new ArrayList<>();
      iceServers.add(
          PeerConnection.IceServer.builder(FALLBACK_STUN_SERVER).createIceServer());
    }

    PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
    // getTransceivers() in startStreamingVideo() is a Unified Plan-only API and
    // aborts the process with "Check failed: IsUnifiedPlan()" under the default
    // (Plan B) semantics, so this must be set explicitly.
    rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    MediaConstraints pcConstraints = new MediaConstraints();

    PeerConnection.Observer pcObserver =
        new PeerConnection.Observer() {
          @Override
          public void onSignalingChange(PeerConnection.SignalingState signalingState) {
            Log.d(TAG, "onSignalingChange: " + signalingState);
          }

          @Override
          public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
            Log.d(TAG, "onIceConnectionChange: " + iceConnectionState);
          }

          @Override
          public void onStandardizedIceConnectionChange(
              PeerConnection.IceConnectionState newState) {}

          @Override
          public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
            Log.d(TAG, "onConnectionChange: " + newState);
          }

          @Override
          public void onIceConnectionReceivingChange(boolean b) {
            Log.d(TAG, "onIceConnectionReceivingChange: " + b);
          }

          @Override
          public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {
            Log.d(TAG, "onIceGatheringChange: " + iceGatheringState);
          }

          @Override
          public void onIceCandidate(IceCandidate iceCandidate) {
            Log.d(TAG, "onIceCandidate: ");
            JSONObject message = new JSONObject();

            try {
              message.put("type", "candidate");
              message.put("label", iceCandidate.sdpMLineIndex);
              message.put("id", iceCandidate.sdpMid);
              message.put("candidate", iceCandidate.sdp);

              Log.d(TAG, "onIceCandidate: sending candidate " + message);
              sendMessage(message);
            } catch (JSONException e) {
              e.printStackTrace();
            }
          }

          @Override
          public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {
            Log.d(TAG, "onIceCandidatesRemoved: ");
          }

          @Override
          public void onSelectedCandidatePairChanged(CandidatePairChangeEvent event) {}

          @Override
          public void onAddStream(MediaStream mediaStream) {
            // Plan B-only callback; with Unified Plan (see createPeerConnection())
            // remote tracks arrive via onAddTrack()/onTrack() below instead.
            Log.d(TAG, "onAddStream: " + mediaStream.videoTracks.size());
          }

          @Override
          public void onRemoveStream(MediaStream mediaStream) {
            Log.d(TAG, "onRemoveStream: ");
          }

          @Override
          public void onDataChannel(DataChannel dataChannel) {
            Log.d(TAG, "onDataChannel: ");
          }

          @Override
          public void onRenegotiationNeeded() {
            Log.d(TAG, "onRenegotiationNeeded: ");
          }

          @Override
          public void onAddTrack(RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {
            // Unified Plan reports the controller's webcam/mic here instead of
            // onAddStream() - our own tracks are local, so this is always the
            // controller's.
            MediaStreamTrack track = rtpReceiver.track();
            Log.d(TAG, "onAddTrack: " + (track != null ? track.kind() : "null"));
            if (track instanceof VideoTrack) {
              remoteVideoTrack = (VideoTrack) track;
              remoteVideoTrack.setEnabled(true);
              showControllerVideo();
            } else if (track instanceof AudioTrack) {
              remoteAudioTrack = (AudioTrack) track;
              remoteAudioTrack.setEnabled(true);
            }
          }

          @Override
          public void onTrack(RtpTransceiver transceiver) {}
        };

    return factory.createPeerConnection(rtcConfig, pcConstraints, pcObserver);
  }
  private void sendMessage(JSONObject message) {
    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("WEB_RTC_EVENT", message));
  }

  private void createVideoTrackFromCameraAndShowIt() {
    audioConstraints = new MediaConstraints();
    videoCapturer = createVideoCapturer();
    VideoSource videoSource = factory.createVideoSource(videoCapturer.isScreencast());

    surfaceTextureHelper =
        SurfaceTextureHelper.create("CaptureThread", rootEglBase.getEglBaseContext());
    videoCapturer.initialize(
        surfaceTextureHelper,
        context /*getApplicationContext()*/,
        videoSource.getCapturerObserver());

    videoCapturer.startCapture(VIDEO_RESOLUTION_WIDTH, VIDEO_RESOLUTION_HEIGHT, FPS);

    videoTrackFromCamera = factory.createVideoTrack(VIDEO_TRACK_ID, videoSource);
    videoTrackFromCamera.setEnabled(true);
    // Not sunk to the view here: the controller's webcam is the default local
    // display (see showControllerVideo()). This track still streams out to the
    // controller regardless of what is shown on this screen.

    // create an AudioSource instance
    audioSource = factory.createAudioSource(audioConstraints);
    localAudioTrack = factory.createAudioTrack("101", audioSource);
  }

  private void initializePeerConnectionFactory() {
    VideoEncoderFactory encoderFactory =
        new DefaultVideoEncoderFactory(rootEglBase.getEglBaseContext(), true, true);
    VideoDecoderFactory decoderFactory =
        new DefaultVideoDecoderFactory(rootEglBase.getEglBaseContext());

    PeerConnectionFactory.InitializationOptions initializationOptions =
        PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions();
    PeerConnectionFactory.initialize(initializationOptions);

    PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
    options.networkIgnoreMask = 16;
    options.disableEncryption = false;
    options.disableNetworkMonitor = true;

    factory =
        PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .setOptions(options)
            .createPeerConnectionFactory();
  }

  private void initializeSurfaceViews() {
    view.init(rootEglBase.getEglBaseContext(), null);
    view.setEnableHardwareScaler(true);
  }

  private VideoCapturer createVideoCapturer() {
    VideoCapturer videoCapturer;
    if (useCamera2()) {
      videoCapturer = createCameraCapturer(new Camera2Enumerator(context));
    } else {
      videoCapturer = createCameraCapturer(new Camera1Enumerator(true));
    }
    return videoCapturer;
  }

  private boolean useCamera2() {
    return Camera2Enumerator.isSupported(context);
  }

  private VideoCapturer createCameraCapturer(CameraEnumerator enumerator) {
    final String[] deviceNames = enumerator.getDeviceNames();

    for (String deviceName : deviceNames) {
      if (enumerator.isBackFacing(deviceName)) {
        VideoCapturer videoCapturer = enumerator.createCapturer(deviceName, null);
        if (videoCapturer != null) {
          return videoCapturer;
        }
      }
    }

    return null;
  }

  // Utils
  private void beep() {
    final ToneGenerator tg = new ToneGenerator(6, 100);
    tg.startTone(ToneGenerator.TONE_CDMA_ALERT_NETWORK_LITE);
  }

  class SignalingHandler {
    void handleControllerWebRtcEvents() {
      ControllerToBotEventBus.subscribe(
          "WEB_RTC_COMMANDS",
          event -> {
            String commandType = "";
            JSONObject webRtcEvent = event.getJSONObject("webrtc_event");
            String type = webRtcEvent.getString("type");
            switch (type) {
              case "offer":
                Timber.d("connectToSignallingServer: received an offer $isInitiator $isStarted");
                peerConnection.setRemoteDescription(
                    new SimpleSdpObserver(),
                    new SessionDescription(
                        SessionDescription.Type.OFFER, webRtcEvent.getString("sdp")));
                doAnswer();
                break;

              case "answer":
                String remoteDescr = webRtcEvent.getString("sdp");
                Timber.i("Got remote description %s", remoteDescr);
                peerConnection.setRemoteDescription(
                    new SimpleSdpObserver(),
                    new SessionDescription(SessionDescription.Type.ANSWER, remoteDescr));
                break;

              case "candidate":
                IceCandidate candidate =
                    new IceCandidate(
                        webRtcEvent.getString("id"),
                        webRtcEvent.getInt("label"),
                        webRtcEvent.getString("candidate"));
                peerConnection.addIceCandidate(candidate);
                break;
            }
          },
          error -> Log.d(TAG, "Error occurred in handleControllerWebRtcEvents: %s", error),
          commandJsn ->
              commandJsn.has("webrtc_event") // filter out all non "webrtc_event" messages.
          );
    }

    public void shutDown() {
      // Not used
      ControllerToBotEventBus.unsubscribe("WEB_RTC_COMMANDS");
    }
  }
}
