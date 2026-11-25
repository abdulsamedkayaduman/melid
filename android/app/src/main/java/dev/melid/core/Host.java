package dev.melid.core;

import org.json.JSONObject;

import java.util.List;

/** SshCore'un platforma (Android ya da test) ihtiyaç duyduğu kancalar. */
public interface Host {
    /** Arayüze olay gönder (data, exit, closed, xfer, fwd ...). Hızlı dönmeli. */
    void emit(String type, JSONObject data);

    /**
     * Kullanıcıya soru sor ve yanıtı bekle (bloklar). null = vazgeçildi.
     * kind: "text" | "password" | "kbd" | "hostkey"
     */
    JSONObject ask(String kind, JSONObject payload) throws InterruptedException;

    /** Oturum (çözülmüş sırlarla: password, passphrase). Yoksa null. */
    JSONObject resolveSession(String id);

    /** "[host]:port" için kayıtlı sunucu anahtarı ({type, key(base64)}) ya da null. */
    JSONObject getKnownHost(String hostPort);

    void putKnownHost(String hostPort, JSONObject entry);

    /** Bağlantı başarılı olunca, kullanıcı "Kaydet" dediyse çağrılır. */
    void saveCredentials(String sessionId, JSONObject creds);

    /** Kayıtlı SSH anahtarları: {id, name, private, passphrase?} (özel anahtar dahil). */
    List<JSONObject> privateKeys();
}
